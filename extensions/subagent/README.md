# Subagents

`subagent` provides six built-in agents (`planning`, `implementation`,
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
own streamed result. Keep parallel tasks independent. Do not combine a subagent
implementation with local mutating tools in the same batch.

Set `background: true` to return a run ID immediately. Four background runs may
execute at once; additional runs wait in FIFO order. Use
`subagent_result({})` to list runs, `subagent_result({ id })` to
inspect one, or `subagent_result({ id, wait: true })` to wait. Interrupting
that wait does not cancel the child. Use `subagent_cancel({ id })` to
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

Define custom agents in `${PI_CODING_AGENT_DIR}/pi-subagent.json`. When
`PI_CODING_AGENT_DIR` is unset or blank, the path is
`~/.pi/agent/pi-subagent.json`.

```json
{
  "overrides": {
    "planning": {
      "disabled": true
    },
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

The optional top-level `overrides` object changes `model`, `thinking`, and/or
`disabled` for any built-in or configured agent. Overrides cannot replace
prompts, descriptions, names, or roles. A built-in override does not affect
custom agents using that role. Delete an override field to restore its agent,
shipped, or parent fallback. Disabled agents remain configurable but disappear
from the `subagent` catalog. When every agent is disabled, the extension
does not register `subagent`. Thinking may be `off`, `minimal`, `low`,
`medium`, `high`, `xhigh`, or `max`.

The built-in role prompt always runs before the custom prompt. Custom agents
cannot replace role policy or configure tools, extensions, or skills. Children
use the selected model's extension-provided tools, while skills remain disabled.

The file is read when the extension loads. Run `/reload` after editing it. The
extension does not read or migrate `pi-explore-subagents.json`.

## Commands

- `/subagent-add` creates a custom agent.
- `/subagent-edit` edits an existing custom agent, including enabled status;
  names are immutable. Saving clears model/thinking runtime overrides for that
  agent so the edited definition becomes authoritative.
- `/subagent-remove` removes a custom agent and its override after confirmation.
- `/subagent-override` selects any agent and changes its runtime model, thinking,
  or enabled status without changing its definition.
- `/subagent-clone` copies any agent into a new custom agent using the source's
  explicit definition values, not its runtime overrides. Clones always start
  enabled. Built-in role prompt text is prefilled as the specialization and must
  be changed before saving to avoid executing the same prompt twice.
- `/subagent-list` lists every built-in and custom agent.

Disabled agents include a `[disabled]` marker in list, edit, override, clone,
and remove views.

Each command keeps changes in memory until final confirmation, writes the JSON
atomically, then reloads Pi. Escape cancels without changing the file. Built-in
agents cannot be edited or removed; use `/subagent-override` for their runtime
settings or `/subagent-clone` to create an editable copy.
