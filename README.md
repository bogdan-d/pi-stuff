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
│   ├── accounts/         # named OAuth and API-key account switching
│   ├── dynamic-resources/  # index.ts + skill/data
│   ├── todo/              # phased, session-aware todo planning
│   └── subagent/           # current subagent implementation
├── deprecated-extensions/ # disabled implementations, including plan-mode
├── tests/                # extension tests and shared test helpers
├── prompts/              # prompt templates (.md) — package resource
├── skills/               # Agent Skills — package resources
└── themes/               # themes (.json) — package resource
```

## Extensions

**Single-file (`extensions/*.ts`):** confirm-destructive, custom-footer,
custom-header, dynamic-tools, git-merge-and-resolve, handoff,
hidden-thinking-label, inline-bash, interactive-shell, message-renderer,
model-status, notify, permission-gate, protected-paths, qna, status-line,
summarize, titlebar-spinner, tools, truncated-tool, widget-placement,
working-indicator.

**Directory:** `accounts`, `dynamic-resources`, `todo`, `subagent`.

**Deprecated reference implementations:** `deprecated-extensions/` contains
the plan mode, prompt customizer, rainbow editor, structured output, former
flat todo, and former subagent implementations. They are not matched by the
package's active extension globs.

### Accounts

`extensions/accounts` provides `/accounts` for switching between named OAuth
and API-key accounts. OAuth supports OpenAI Codex, Anthropic, and GitHub Copilot.
API-key providers are discovered from Pi's interactive login support, including
Z.AI for GLM. Add each key with **Login new account**, give it a name, then use
the provider's switch action when you want another key. Switching to another
provider opens its model picker. Switching accounts within the current provider
keeps your model. Cancelling the picker leaves the account selected but keeps
the current model. Providers supporting both login methods offer an OAuth or
API-key choice.

Credentials stay in the private `~/.pi/agent/pi-accounts.json` file. OAuth
refresh runs under a file lock. Each provider has an independent active account.
Selecting `default` restores Pi's own login without overwriting it. Switching
is manual, with no automatic quota-based rotation. API-key accounts accept
literal keys, not provider environment settings or ambient-only authentication.

The extension is loaded automatically by the package's
`extensions/*/index.ts` manifest entry. Its tests live under
`tests/accounts/`.

### Todo

`extensions/todo` provides a phased, session-aware `todo` tool with branch
restoration, transient reminders, native result rendering, and a persistent
plan widget. Its tests live under `tests/todo/`.

The former flat sample extension is kept as
`deprecated-extensions/todo_deprecated.ts` for reference.

## Skills, prompts & themes

`skills/`, `prompts/*.md`, and `themes/*.json` are served directly by the
package (declared in the `pi` manifest). Edit them here and `/reload` — Pi
picks them up. No copy to `~/.pi/agent` is needed; the package is the single
source.

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
  "skills":     ["./skills"]
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
