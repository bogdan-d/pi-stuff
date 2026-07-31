# Delegated agents

`delegate_agent` provides four built-in agents (`planning`, `implementation`,
`verification`, and `review`) plus optional named specializations.

Define custom agents in `${PI_CODING_AGENT_DIR}/pi-delegated-agents.json`. When
`PI_CODING_AGENT_DIR` is unset or blank, the path is
`~/.pi/agent/pi-delegated-agents.json`.

```json
{
  "agents": {
    "rust-implementer": {
      "role": "implementation",
      "description": "Implements focused, idiomatic Rust changes.",
      "model": "openai-codex/gpt-5.6-terra",
      "thinking": "high",
      "prompt": "Prefer idiomatic Rust, explicit ownership, and focused cargo checks."
    }
  }
}
```

Each agent requires `role`, `description`, and `prompt`. `role` must name one
of the four built-ins. Optional `model` and `thinking` override the parent
session; omitted values inherit it. Thinking may be `off`, `minimal`, `low`,
`medium`, `high`, `xhigh`, or `max`.

The built-in role prompt always runs before the custom prompt. Custom agents
cannot replace role policy or configure tools, extensions, or skills. Children
use the selected model's extension-provided tools, while skills remain disabled.

The file is read when the extension loads. Run `/reload` after editing it.

## Commands

- `/agent-add` creates a custom agent.
- `/agent-edit` edits an existing custom agent; names are immutable.
- `/agent-remove` removes a custom agent after confirmation.

Each command keeps changes in memory until final confirmation, writes the JSON
atomically, then reloads Pi. Escape cancels without changing the file. Built-in
agents cannot be edited or removed.
