# Delegated agents

`delegate_agent` provides six built-in agents (`planning`, `implementation`,
`verification`, `review`, `explore-shallow`, and `explore-deep`) plus optional
named specializations.

Use `explore-shallow` for bounded reconnaissance: likely hotspots, entry points,
immediate relationships, and best next reads. Use `explore-deep` for broad
surveys, triage, compare/rank work, and cross-file synthesis. Both are
discovery-only by instruction and require a standalone brief because children
do not inherit parent conversation. Their read-only behavior is prompt-enforced,
not a filesystem or tool sandbox.

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

Active runs live only in the current runtime. Reload, session replacement, or
shutdown cancels them. Compact terminal summaries persist on the current
session branch and survive resume and fork. Completion notices are queued for
the next turn and never wake the parent automatically. Full child usage counts
toward parent totals only on the first terminal result retrieval.

Run `/agents` to inspect foreground and background calls without involving the
parent model. The modal shows active work first, then branch history. Enter opens
details; `/` filters; `c` confirms cancellation of owned active background work;
`f` loads the next bounded page of a retained full-output file; and `y` copies
the run ID. Arrow keys or
`j/k` navigate and scroll. Forked/reloaded history is marked inherited and
cannot be cancelled. Tool timelines retain bounded path-oriented summaries;
raw arguments, results, shell commands, messages, and reasoning are not stored.

Only one non-terminal implementation may target a resolved working directory
by default. Do not duplicate a background implementation's work.
`allowConcurrentWrites: true` accepts the overlap risk for partitioned work;
it is not filesystem isolation and cannot guard against parent edits.

Define custom agents in `${PI_CODING_AGENT_DIR}/pi-delegated-agents.json`. When
`PI_CODING_AGENT_DIR` is unset or blank, the path is
`~/.pi/agent/pi-delegated-agents.json`.

```json
{
  "overrides": {
    "explore-shallow": {
      "model": "openai-codex/gpt-5.6-luna",
      "thinking": "low"
    },
    "explore-deep": {
      "model": "openai-codex/gpt-5.6-terra",
      "thinking": "low"
    }
  },
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

Each custom agent requires `role`, `description`, and `prompt`. `role` must name
one of the six built-ins. Optional `model` and `thinking` override role defaults
and then the parent session. Explore roles ship with the defaults shown above;
the original four roles inherit the parent. Custom agents based on an explore
role inherit its shipped defaults when omitted.

The optional top-level `overrides` object changes `model` and/or `thinking` for
named built-ins. It accepts all six built-in names but cannot replace prompts,
descriptions, names, or roles. A built-in override does not affect custom agents
using that role. Delete an override field to restore its shipped or parent
fallback. Thinking may be `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or
`max`.

The built-in role prompt always runs before the custom prompt. Custom agents
cannot replace role policy or configure tools, extensions, or skills. Children
use the selected model's extension-provided tools, while skills remain disabled.

The file is read when the extension loads. Run `/reload` after editing it. The
extension does not read or migrate `pi-explore-subagents.json`.

## Commands

- `/agent-add` creates a custom agent.
- `/agent-edit` edits an existing custom agent; names are immutable.
- `/agent-remove` removes a custom agent after confirmation.

Each command keeps changes in memory until final confirmation, writes the JSON
atomically, then reloads Pi. Escape cancels without changing the file. Built-in
agents cannot be edited or removed; edit their JSON `overrides` directly. The
commands preserve existing overrides.
