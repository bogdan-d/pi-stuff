# pi-stuff

Personal [Pi](https://pi.dev) coding agent extensions. Version-controlled and
loaded by Pi as a local-path package, so edits are live and `/reload` picks
them up.

## Structure

```
pi-stuff/
├── package.json          # pi package manifest + bun tooling
├── tsconfig.json         # strict TypeScript (noEmit)
├── biome.json            # formatter (tabs, double quotes)
└── extensions/
    ├── *.ts              # single-file extensions (26)
    ├── dynamic-resources/  # index.ts + skill/data
    ├── plan-mode/          # index.ts + utils.ts (registers --plan flag)
    └── subagent/           # index.ts + agents.ts + prompts/ + agents/
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

## Install (local, live edit)

Loaded directly from this working tree — no copy, edits reflect immediately.

Add to `~/.pi/agent/settings.json`:

```jsonc
{
  "packages": ["/var/mnt/xdata/code/pi/pi-stuff"]
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
