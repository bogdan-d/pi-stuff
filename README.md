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
│   ├── *.ts              # single-file extensions (14)
│   ├── accounts/         # named OAuth and API-key account switching
│   ├── ask/              # questionnaire (excluded from loading)
│   ├── context/          # /context window usage breakdown
│   ├── subagent/         # current subagent implementation
│   └── todo/             # phased, session-aware todo planning
├── deprecated-extensions/ # disabled implementations, including plan-mode
├── tests/                # extension tests and shared test helpers
├── prompts/              # prompt templates (.md) — package resource
└── themes/               # themes (.json) — package resource
```

## Extensions

**Single-file (`extensions/*.ts`):** codex-usage-status, confirm-destructive,
handoff, inline-bash, interactive-shell, notify, permission-gate,
prefill-progress, protected-paths, qna, rg, summarize, titlebar-spinner, tools.

**Directory:** `accounts`, `context`, `subagent`, `todo`. `ask` lives here too
but is excluded by the manifest (`!extensions/ask/*.ts`).

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

Interactive sessions remember your last-used provider, model, and thinking level
in `~/.pi/agent/pi-accounts-selection.json`. Fresh sessions restore that choice
after account authentication. Before a choice is remembered, the configured Pi
default is used to recover an unknown startup model. Explicit CLI model choices
take precedence. Resumed sessions keep their transcript selection, and reloading
keeps the current model. Headless sessions use their assigned model and do not
update interactive preferences. Concurrent interactive sessions share this file;
the last selection or submitted turn wins.

Standalone Pi login is not required for selected accounts. Pi 0.85.1 may still
display its earlier "No models available" startup warning even after accounts
restores a usable model. Failed restoration reports an error instead of selecting
another account. The subagent extension initializes inherited extensions before
prompting so accounts can supply authentication before Pi's preflight check.

The extension is loaded automatically by the package's
`extensions/*/index.ts` manifest entry. Its tests live under
`tests/accounts/`.

### Todo

`extensions/todo` provides a phased, session-aware `todo` tool with branch
restoration, transient reminders, native result rendering, and a persistent
plan widget. Its tests live under `tests/todo/`.

The former flat sample extension is kept as
`deprecated-extensions/todo_deprecated.ts` for reference.

### Prefill progress

`extensions/prefill-progress.ts` adds prompt-processing progress to Zentui's existing Working line through its keyed segment protocol (no Footer widget or renderer replacement). In TUI mode with that line active, it opts streaming `openai-completions` requests into `return_progress: true` only for `halogen/halogen-qwen3.8-flash-next`, `gufo/qwen3.8-flash-next`, and `strixite/qwen3.8-flash-next`; other requests remain unchanged. `Prefill 200/800 (25%) · cache 200` means 200 newly processed tokens out of 800 uncached tokens, plus 200 cached tokens, not 400 newly processed tokens. Fully cached and empty prompts have explicit labels; malformed progress is ignored and updates are coalesced at 250 ms. Progress disappears on decode, completion, cancellation/error, retry, identity changes, or shutdown, preserving Zentui's Cooking message and decode tok/s. Requires Zentui's active Working-line segment integration; without it this extension stays silent rather than competing for Pi's unkeyed working-message slot. `/reload` activates edits; focused tests live in `tests/prefill-progress.test.ts`.

## Prompts & themes

`prompts/*.md` and `themes/*.json` are served directly by the
package (declared in the `pi` manifest). Edit them here and `/reload` — Pi
picks them up. No copy to `~/.pi/agent` is needed; the package is the single
source.

## Agents

Agents are **not** a Pi package resource (no manifest key). The deprecated
`subagent_deprecated` implementation keeps its role prompts in
`deprecated-extensions/subagent_deprecated/prompts/*.md` and stays outside
package loading while replacement work proceeds.

## Package resources & filtering

The `pi` manifest declares resource globs (paths relative to the package
root):

```jsonc
"pi": {
  "extensions": ["extensions/*.ts", "extensions/*/index.ts", "!extensions/ask/*.ts"],
  "prompts":    ["prompts"],
  "themes":     ["themes"]
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
bun run check      # biome check + tsc --noEmit + bun test
bun run format     # autofix formatting
```

Runtime deps are Pi core packages (declared as `peerDependencies`, provided by
Pi at runtime), plus `proper-lockfile` for the accounts extension's storage.

## License

MIT
