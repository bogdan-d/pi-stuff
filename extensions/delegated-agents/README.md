# Delegated agents

`delegate_agent` provides four built-in agents (`planning`, `implementation`,
`verification`, and `review`) plus optional named specializations.

## Parallel and background runs

Independent foreground calls in one tool batch run in parallel and return their
own streamed result. Keep parallel tasks independent. Do not combine a delegated
implementation with local mutating tools in the same batch.

Set `background: true` to return a run ID immediately. Four background runs may
execute at once; additional runs wait in FIFO order. Use
`delegate_agent_result({})` to list runs, `delegate_agent_result({ id })` to
inspect one, or `delegate_agent_result({ id, wait: true })` to wait. Interrupting
that wait does not cancel the child. Use `delegate_agent_cancel({ id })` to
cancel queued or running work.

Runs and terminal records live only in the current parent session. Reload,
session replacement, or shutdown cancels active work. Completion notices are
queued for the next turn and never wake the parent automatically. Full child
usage counts toward parent totals only on the first terminal result retrieval.

Only one non-terminal implementation may target a resolved working directory
by default. Do not duplicate a background implementation's work.
`allowConcurrentWrites: true` accepts the overlap risk for partitioned work;
it is not filesystem isolation and cannot guard against parent edits.

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
