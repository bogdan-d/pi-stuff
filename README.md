# pi-stuff

Personal [Pi](https://pi.dev) coding agent extensions. Version-controlled and
loaded by Pi as a local-path package, so edits are live and `/reload` picks
them up.

## Structure

```
pi-stuff/
├── package.json          # pi manifest (extensions + prompts + themes) + bun tooling
├── tsconfig.json         # strict TypeScript (noEmit)
├── biome.json            # formatter (tabs, double quotes)
├── extensions/
│   ├── *.ts              # single-file extensions (26)
│   ├── dynamic-resources/  # index.ts + skill/data
│   ├── plan-mode/          # index.ts + utils.ts (registers --plan flag)
│   └── subagent/           # index.ts + agents.ts; seeds bundled agents/*.md
├── prompts/              # prompt templates (.md) — package resource
└── themes/               # themes (.json) — package resource
```

## Extensions

**Single-file (`extensions/*.ts`):** confirm-destructive, custom-footer,
custom-header, dynamic-tools, git-merge-and-resolve, handoff,
hidden-thinking-label, inline-bash, interactive-shell, message-renderer,
model-status, notify, permission-gate, prompt-customizer, protected-paths,
qna, rainbow-editor, status-line, structured-output, summarize,
titlebar-spinner, todo, tools, truncated-tool, widget-placement,
working-indicator.

**Directory:** `dynamic-resources`, `plan-mode`, `subagent`.

## Prompts & themes

`prompts/*.md` and `themes/*.json` are served directly by the package
(declared in the `pi` manifest). Edit them here and `/reload` — Pi picks them
up. No copy to `~/.pi/agent` is needed; the package is the single source.

## Agents

Agents are **not** a Pi package resource (no manifest key). The `subagent`
extension ships its agent definitions in `extensions/subagent/agents/*.md` and
**seeds** them: on `session_start` (startup / reload) it copies each bundled
agent to `~/.pi/agent/agents/<name>.md` when that file is missing or its
checksum differs. Bundled files are canonical — edit them here and `/reload` to
propagate. Local edits to the seeded files are overwritten on the next seed.

## Package resources & filtering

The `pi` manifest declares resource globs (paths relative to the package
root):

```jsonc
"pi": {
  "extensions": ["./extensions/*.ts", "./extensions/*/index.ts"],
  "prompts":    ["./prompts"],
  "themes":     ["./themes"],
  "skills":     ["./skills"]   // optional, not used here
}
```

Globs support **`!exclusions`** — prefix a pattern with `!` to drop matches:

```jsonc
"extensions": ["./extensions/*.ts", "!extensions/legacy.ts"]
```

For finer control, use the **object form** in `settings.json` to filter what a
package loads (narrows the manifest, never widens):

```jsonc
{
  "packages": [
    {
      "source": "/path/to/pi-stuff",
      "extensions": ["extensions/*.ts", "!extensions/todo.ts"],
      "prompts":    [],
      "themes":     ["+themes/opus-console.json"]
    }
  ]
}
```

- Omit a key → load all of that type. `[]` → load none.
- `!pattern` → exclude glob matches.
- `+path` → force-include an exact path. `-path` → force-exclude an exact path.

Enable/disable individual resources at runtime with `pi config`.

## Install (local, live edit)

Loaded directly from this working tree — no copy, edits reflect immediately.

Add to `~/.pi/agent/settings.json`:

```jsonc
{
  "packages": ["/path/to/pi-stuff"]
}
```

Then `/reload` in Pi.

## Install (git, pinned)

```bash
pi install git:github.com/bogdan-d/pi-stuff@main
```

Clones to `~/.pi/agent/git/github.com/bogdan-d/pi-stuff`, pinned to the ref.
Update with `pi update --extensions`, bump with
`pi install git:github.com/bogdan-d/pi-stuff@<new-ref>`.

## Develop

```bash
bun install        # dev tooling (typescript, biome, pi core types)
bun run check      # biome format check + tsc --noEmit
bun run format     # autofix formatting
```

Runtime deps are Pi core packages (declared as `peerDependencies`, provided by
Pi at runtime). No npm runtime dependencies.

## License

MIT
