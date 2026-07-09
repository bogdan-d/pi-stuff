# Repository Guidelines

## Project Structure & Module Organization

This repository is a private Bun/TypeScript package for Pi coding agent extensions. `package.json` is both the Bun manifest and Pi package manifest. Source lives under `extensions/`: single-file extensions are `extensions/*.ts`, while multi-file extensions use folders such as `extensions/subagent/`, `extensions/plan-mode/`, and `extensions/dynamic-resources/` with an `index.ts` entry. Prompt templates live in `prompts/*.md`; theme JSON files live in `themes/*.json`. TypeScript config only includes `extensions/**/*.ts`, so code outside that tree is not typechecked.

## Build, Test, and Development Commands

Use Bun 1.3.14 or newer compatible Bun.

- `bun install`: install dev tooling and Pi type packages.
- `bun run check`: run Biome checks, then `tsc --noEmit`.
- `bun run lint`: run `biome check .`; lint rules are disabled, but formatting/import checks still apply.
- `bun run typecheck`: run strict TypeScript validation.
- `bun run format`: apply Biome formatting fixes.

There is no build output; this package is loaded directly by Pi. After local edits, use `/reload` in Pi.

## Coding Style & Naming Conventions

Use TypeScript ESM with strict compiler settings. Biome formatting uses tabs, double quotes, semicolons, and trailing commas. Keep extension filenames kebab-case, for example `extensions/permission-gate.ts`. Directory extensions should expose `index.ts`; shared helpers stay near their feature, as in `extensions/plan-mode/utils.ts`. Avoid unused locals and parameters because `tsconfig.json` rejects them.

## Testing Guidelines

No dedicated test framework is configured. Treat `bun run check` as the required validation gate before submitting changes. For runtime behavior, test by loading the package in Pi and using `/reload`; include the affected extension, prompt, or theme in manual test notes. If tests are added later, keep them close to the extension they cover and document the new command in `package.json`.

## Commit & Pull Request Guidelines

History uses short, imperative messages; scoped prefixes appear when useful, for example `docs: document !exclusions + package filtering`. Keep commits focused on one change. Pull requests should include a brief purpose, changed resources or extensions, validation output from `bun run check`, and manual Pi reload notes when behavior changes. Link related issues when available.

## Security & Configuration Tips

Do not commit local Pi settings or generated files from `~/.pi/agent`. Bundled subagent definitions in `extensions/subagent/agents/*.md` are canonical and may overwrite seeded local copies on reload. Keep package resource globs in `package.json` narrow and intentional.
