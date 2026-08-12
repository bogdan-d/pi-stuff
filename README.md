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
│   ├── accounts/         # named subscription OAuth account switching
│   ├── dynamic-resources/  # index.ts + skill/data
│   ├── plan-mode/          # index.ts + utils.ts (registers --plan flag)
│   ├── todo/              # phased, session-aware todo planning
│   └── subagent/           # current subagent implementation
├── deprecated-extensions/ # disabled implementations kept for reference
├── tests/                # extension tests and shared test helpers
├── prompts/              # prompt templates (.md) — package resource
└── themes/               # themes (.json) — package resource
```

## Extensions

**Single-file (`extensions/*.ts`):** confirm-destructive, custom-footer,
custom-header, dynamic-tools, git-merge-and-resolve, handoff,
hidden-thinking-label, inline-bash, interactive-shell, message-renderer,
model-status, notify, permission-gate, protected-paths, qna, status-line,
summarize, titlebar-spinner, tools, truncated-tool, widget-placement,
working-indicator.

**Directory:** `accounts`, `dynamic-resources`, `plan-mode`, `todo`, `subagent`.

**Deprecated reference implementations:** `deprecated-extensions/` contains
the prompt customizer, rainbow editor, structured output, former flat todo,
and former subagent implementations. They are not matched by the package's
active extension globs.

### Accounts

`extensions/accounts` provides the `/accounts` command for managing named
subscription OAuth accounts across OpenAI Codex, Anthropic, and GitHub Copilot.
It stores credentials in `~/.pi/agent/pi-accounts.json`, refreshes them under a
file lock, and keeps each provider's active account independent.

The extension is loaded automatically by the package's
`extensions/*/index.ts` manifest entry. Its tests live under
`tests/accounts/`.

### Todo

`extensions/todo` provides a phased, session-aware `todo` tool with branch
restoration, transient reminders, native result rendering, and a persistent
plan widget. Its tests live under `tests/todo/`.

The former flat sample extension is kept as
`deprecated-extensions/todo_deprecated.ts` for reference.

## Prompts & themes

`prompts/*.md` and `themes/*.json` are served directly by the package
(declared in the `pi` manifest). Edit them here and `/reload` — Pi picks them
up. No copy to `~/.pi/agent` is needed; the package is the single source.

## Agents

Agents are **not** a Pi package resource (no manifest key). The deprecated
The deprecated `subagent_deprecated` implementation keeps its role prompts in
`deprecated-extensions/subagent_deprecated/prompts/*.md` and stays outside
package loading while replacement work proceeds.

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
      "extensions": [
        "extensions/*.ts",
        "extensions/*/index.ts",
        "!extensions/todo/index.ts"
      ],
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
Pi at runtime), plus `proper-lockfile` for the accounts extension's storage.

## License

MIT
