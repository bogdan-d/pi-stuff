import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
	discoverInheritedExtensionPaths,
	discoverInheritedSkillPaths,
} from "../../../extensions/subagent/execute.js";

async function makeWorkspace() {
	const root = await mkdtemp(join(tmpdir(), "extension-paths-"));
	const agentDir = join(root, "agent");
	const cwd = join(root, "cwd");
	await mkdir(join(agentDir, "extensions"), { recursive: true });
	await mkdir(join(cwd, ".pi", "extensions"), { recursive: true });
	return { agentDir, cwd };
}

test("discovers enabled inherited extension paths in stable deduplicated order", async () => {
	const { agentDir, cwd } = await makeWorkspace();
	const projectOne = join(cwd, ".pi", "extensions", "one.ts");
	const projectTwo = join(cwd, ".pi", "extensions", "two.ts");
	const disabled = join(cwd, ".pi", "extensions", "disabled.ts");
	const global = join(agentDir, "extensions", "global.ts");
	await writeFile(projectOne, "export default () => {};");
	await writeFile(projectTwo, "export default () => {};");
	await writeFile(disabled, "export default () => {};");
	await writeFile(global, "export default () => {};");
	await writeFile(
		join(cwd, ".pi", "settings.json"),
		JSON.stringify({
			extensions: ["extensions/one.ts", "!extensions/disabled.ts"],
		}),
	);

	const paths = await discoverInheritedExtensionPaths(cwd, agentDir);

	assert.deepEqual(paths, [projectOne, projectTwo, global]);
});

test("excludes this package's extension entry through a symlink without excluding other extensions", async () => {
	const { agentDir, cwd } = await makeWorkspace();
	const selfLink = join(cwd, ".pi", "extensions", "self.ts");
	const other = join(cwd, ".pi", "extensions", "other.ts");
	const ownEntry = fileURLToPath(
		new URL("../../../extensions/subagent/index.js", import.meta.url),
	);
	await symlink(ownEntry, selfLink);
	await writeFile(other, "export default () => {};");

	const paths = await discoverInheritedExtensionPaths(cwd, agentDir);

	assert.deepEqual(paths, [other]);
});

test("discovers skills provided by configured packages", async () => {
	const { agentDir, cwd } = await makeWorkspace();
	const packageDir = join(cwd, "skill-package");
	const skillDir = join(packageDir, "skills", "packaged-review");
	const skillFile = join(skillDir, "SKILL.md");
	await mkdir(skillDir, { recursive: true });
	await writeFile(
		skillFile,
		"---\nname: packaged-review\ndescription: Review packaged code.\n---\nReview carefully.\n",
	);
	await writeFile(
		join(packageDir, "package.json"),
		JSON.stringify({ pi: { skills: ["./skills"] } }),
	);
	await writeFile(
		join(agentDir, "settings.json"),
		JSON.stringify({ packages: [packageDir] }),
	);

	const paths = await discoverInheritedSkillPaths(cwd, agentDir);

	assert.equal(paths.filter((path) => path === skillFile).length, 1);
});
