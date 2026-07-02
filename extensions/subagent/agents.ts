/**
 * Agent discovery and configuration
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

/** Directory of agent .md files bundled with this extension. */
const BUNDLED_AGENTS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "agents",
);

export type AgentScope = "user" | "project" | "both";

export interface AgentConfig {
  name: string;
  description: string;
  tools?: string[];
  model?: string;
  systemPrompt: string;
  source: "user" | "project";
  filePath: string;
}

export interface AgentDiscoveryResult {
  agents: AgentConfig[];
  projectAgentsDir: string | null;
}

function loadAgentsFromDir(
  dir: string,
  source: "user" | "project",
): AgentConfig[] {
  const agents: AgentConfig[] = [];

  if (!fs.existsSync(dir)) {
    return agents;
  }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return agents;
  }

  for (const entry of entries) {
    if (!entry.name.endsWith(".md")) continue;
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;

    const filePath = path.join(dir, entry.name);
    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }

    const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);

    if (!frontmatter.name || !frontmatter.description) {
      continue;
    }

    const tools = frontmatter.tools
      ?.split(",")
      .map((t: string) => t.trim())
      .filter(Boolean);

    agents.push({
      name: frontmatter.name,
      description: frontmatter.description,
      tools: tools && tools.length > 0 ? tools : undefined,
      model: frontmatter.model,
      systemPrompt: body,
      source,
      filePath,
    });
  }

  return agents;
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function findNearestProjectAgentsDir(cwd: string): string | null {
  let currentDir = cwd;
  while (true) {
    const candidate = path.join(currentDir, ".pi", "agents");
    if (isDirectory(candidate)) return candidate;

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) return null;
    currentDir = parentDir;
  }
}

export function discoverAgents(
  cwd: string,
  scope: AgentScope,
): AgentDiscoveryResult {
  const userDir = path.join(getAgentDir(), "agents");
  const projectAgentsDir = findNearestProjectAgentsDir(cwd);

  const userAgents =
    scope === "project" ? [] : loadAgentsFromDir(userDir, "user");
  const projectAgents =
    scope === "user" || !projectAgentsDir
      ? []
      : loadAgentsFromDir(projectAgentsDir, "project");

  const agentMap = new Map<string, AgentConfig>();

  if (scope === "both") {
    for (const agent of userAgents) agentMap.set(agent.name, agent);
    for (const agent of projectAgents) agentMap.set(agent.name, agent);
  } else if (scope === "user") {
    for (const agent of userAgents) agentMap.set(agent.name, agent);
  } else {
    for (const agent of projectAgents) agentMap.set(agent.name, agent);
  }

  return { agents: Array.from(agentMap.values()), projectAgentsDir };
}

export function formatAgentList(
  agents: AgentConfig[],
  maxItems: number,
): { text: string; remaining: number } {
  if (agents.length === 0) return { text: "none", remaining: 0 };
  const listed = agents.slice(0, maxItems);
  const remaining = agents.length - listed.length;
  return {
    text: listed
      .map((a) => `${a.name} (${a.source}): ${a.description}`)
      .join("; "),
    remaining,
  };
}

export interface AgentSeedResult {
  /** Filenames copied (missing or checksum differed). */
  copied: string[];
  /** Files already matching the bundled version. */
  upToDate: number;
  /** Resolved target directory (~/.pi/agent/agents). */
  targetDir: string;
}

function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Seed the user agent directory (~/.pi/agent/agents) from the .md files
 * bundled with this extension.
 *
 * A bundled agent is copied when its target is missing or its checksum
 * differs; matching files are skipped. Idempotent. The bundled files are the
 * source of truth — edit them in the repo and reload to propagate. Local edits
 * to the seeded files are overwritten on the next seed.
 */
export async function seedBundledAgents(): Promise<AgentSeedResult> {
  const targetDir = path.join(getAgentDir(), "agents");
  await fs.promises.mkdir(targetDir, { recursive: true });

  const copied: string[] = [];
  let upToDate = 0;

  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(BUNDLED_AGENTS_DIR, {
      withFileTypes: true,
    });
  } catch {
    return { copied, upToDate: 0, targetDir };
  }

  for (const entry of entries) {
    if (!entry.name.endsWith(".md")) continue;
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;

    const src = path.join(BUNDLED_AGENTS_DIR, entry.name);
    const dst = path.join(targetDir, entry.name);

    const srcData = await fs.promises.readFile(src);
    const srcHash = sha256(srcData);

    let needsCopy = true;
    try {
      const dstData = await fs.promises.readFile(dst);
      if (sha256(dstData) === srcHash) needsCopy = false;
    } catch {
      // target missing → copy
    }

    if (needsCopy) {
      await fs.promises.copyFile(src, dst);
      copied.push(entry.name);
    } else {
      upToDate++;
    }
  }

  return { copied, upToDate, targetDir };
}
