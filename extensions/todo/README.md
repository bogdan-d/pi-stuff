# Todo Extension

Phased, session-aware todo planning for Pi coding agent sessions.

## Features

- Organize work into phases with named tasks and descriptions.
- Track `pending`, `in_progress`, `completed`, and `cancelled` statuses.
- Restore todo state when navigating session branches.
- Keep active work visible in a persistent widget.
- Inject transient reminders when an open plan becomes stale.
- Render compact and expanded native tool output.

## Usage

The extension is loaded automatically through the package manifest. To load it
directly while developing:

```bash
pi -e ./extensions/todo/index.ts
```

The model-facing tool supports four actions:

- `set(phases)` replaces the plan; supplied tasks start as `pending`.
- `add(phases)` adds new phases or tasks without changing existing statuses.
- `transition(transitions, workingOn?)` updates tasks by phase and task name.
- `view()` returns the complete plan, including descriptions.

Use `/todo` to hide or show the persistent todo list.

## Settings

Global settings are read from `~/.pi/agent/todo/settings.json`. For trusted
projects, `.pi/todo/settings.json` overrides global values.

```json
{
  "widgetPlacement": "aboveEditor",
  "maxVisibleTasks": 5,
  "fallbackGlyphs": false,
  "toolVisibility": "set-only",
  "dynamicReminders": true,
  "reminderMinTurns": 4,
  "reminderMaxTurns": 8,
  "reminderOutputTokens": 16000,
  "reminderMaxPerRun": 2
}
```

Run focused tests with `bun test tests/todo`.
