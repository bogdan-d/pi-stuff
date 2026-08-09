# 01 — Add shortcut for subagent TUI

**What to build:** Add a global `Ctrl+Alt+A` shortcut that opens the new `/subagents` management UI, matching the deprecated subagent extension's shortcut.

**Blocked by:** None — can start immediately.

**Status:** needs-triage

## Current behavior

The active `extensions/subagent` extension registers the `/subagents` command but no direct keyboard shortcut. The deprecated extension registered `Key.ctrlAlt("a")` for its subagent inspector.

## Acceptance criteria

- [ ] Register `Ctrl+Alt+A` through the active extension's shortcut API.
- [ ] Shortcut opens the same `/subagents` overlay and initial state as invoking `/subagents` without arguments.
- [ ] Reuse one handler path so command and shortcut behavior stay consistent.
- [ ] Keep existing command arguments, settings flow, overlay close behavior, and runtime state unchanged.
- [ ] Handle non-TUI contexts safely, matching existing command behavior.
- [ ] Detect or document conflicts with existing global shortcuts; do not silently break unrelated bindings.
- [ ] Add focused registration and invocation tests, including shortcut cleanup or duplicate-registration behavior if the extension reloads.
- [ ] Document the shortcut in relevant subagent README or TUI help text.

## Design constraints

- Use Pi's existing `Key.ctrlAlt("a")` and `pi.registerShortcut` APIs rather than parsing terminal escape sequences locally.
- Shortcut must target active `/subagents` command, not deprecated inspector code.
- Preserve compatibility with terminals that cannot transmit `Ctrl+Alt+A`; users must retain `/subagents` command access.

## Relevant code

- `extensions/subagent/index.ts`
- `extensions/subagent/command/index.ts`
- `extensions/subagent_deprecated/inspector.ts`
- `extensions/subagent/README.md`

## Comments
