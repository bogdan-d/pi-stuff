# Dynamic Resources Extension

`extensions/dynamic-resources` is a small example Pi extension showing how to register resources at runtime.

It listens for Pi's `resources_discover` event and returns paths to extra resources:

- skills
- prompt templates
- themes

Current implementation:

```ts
pi.on("resources_discover", () => {
	return {
		skillPaths: [join(baseDir, "SKILL.md")],
		promptPaths: [join(baseDir, "dynamic.md")],
		themePaths: [join(baseDir, "dynamic.json")],
	};
});
```

## What it adds

This repository's example contributes:

- `extensions/dynamic-resources/SKILL.md`
  - skill name: `dynamic-resources`
  - description: example skill loaded from `resources_discover`
- `extensions/dynamic-resources/dynamic.md`
  - prompt template asking Pi to summarize repo structure and build/test commands
- `extensions/dynamic-resources/dynamic.json`
  - theme named `dynamic-resources`

The extension has no other runtime behavior. It mainly demonstrates dynamic resource discovery.

## When to use this pattern

Use `resources_discover` when resource lists should be computed instead of fixed in `package.json`.

Good fit:

- resources depend on current repo
- resources depend on env vars or feature flags
- resources live outside the package
- resources are generated at startup/reload
- resources should appear only when relevant

Pi fires `resources_discover` after `session_start`.

- startup uses `reason: "startup"`
- reload uses `reason: "reload"`

After editing or changing generated resources, use `/reload` in Pi.

## Use cases

### Project-specific skills

Detect repository type from `event.cwd` and load only relevant skills.

Examples:

- `package.json` exists -> load TypeScript/Node skills
- `Cargo.toml` exists -> load Rust skills
- `terraform/` exists -> load infrastructure/security skills
- Pi extension repo -> load Pi extension development skill

### Conditional prompt templates

Expose prompts only when useful.

Examples:

- Node repo -> npm audit prompt
- Docker repo -> container hardening prompt
- frontend repo -> UI review prompt
- monorepo -> workspace summary prompt

### Team or private resource packs

Keep shared prompts/skills/themes in another directory, such as:

```txt
~/company/pi-resources/
```

The extension can return paths from that directory. This avoids copying resources into every repo.

### Generated resources

An extension can scan repo docs or config, generate resource files into a cache/temp directory, then return those paths.

Examples:

- generate a prompt listing detected workspaces
- generate a skill from internal coding standards
- generate project-specific runbook prompts from `docs/`

### Feature flags and profiles

Use env vars to choose resources.

Examples:

- `PI_EXPERIMENTAL=1` -> load experimental prompts
- `WORK_PROFILE=client-a` -> load client-specific instructions
- `SECURITY_MODE=strict` -> load stricter review skills

### Theme packs

Discover themes dynamically from a theme folder.

Examples:

- load all themes in `~/.config/pi/themes/*.json`
- load only dark/light theme based on env/profile
- expose company-branded themes only on work machines

### Monorepo-aware resources

Scan workspaces and expose resources for detected areas.

Examples:

- `apps/web` -> frontend prompts
- `services/api` -> backend prompts
- `infra` -> ops prompts
- `packages/sdk` -> API docs prompts

## Example: detect repo type

```ts
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const baseDir = dirname(fileURLToPath(import.meta.url));

export default function (pi: ExtensionAPI) {
	pi.on("resources_discover", async (event) => {
		const skillPaths: string[] = [];
		const promptPaths: string[] = [];
		const themePaths: string[] = [];

		if (existsSync(join(event.cwd, "package.json"))) {
			skillPaths.push(join(baseDir, "skills/typescript.md"));
			promptPaths.push(join(baseDir, "prompts/npm-audit.md"));
		}

		if (existsSync(join(event.cwd, "Cargo.toml"))) {
			skillPaths.push(join(baseDir, "skills/rust.md"));
		}

		return { skillPaths, promptPaths, themePaths };
	});
}
```

## Example: use env flag

```ts
pi.on("resources_discover", () => {
	if (process.env.PI_EXPERIMENTAL !== "1") {
		return {};
	}

	return {
		promptPaths: [join(baseDir, "prompts/experimental-review.md")],
	};
});
```

## Practical ideas for this repo

Possible next experiments:

1. Add a `resources/` folder with several optional skill and prompt packs.
2. Load TypeScript-specific prompts only when `package.json` exists.
3. Load Pi-extension prompts only when `package.json` contains Pi package metadata.
4. Load security review skills when repo has infra files, Dockerfiles, or CI workflows.
5. Add env-based profiles, for example `PI_PROFILE=work` or `PI_PROFILE=personal`.

## Key takeaway

Static resources are good when every repo should always see them.

Dynamic resources are better when Pi should adapt to the current repo, user profile, generated files, or runtime config.
