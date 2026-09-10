# pi-stuff/subagent

Delegate focused work from Pi to context-isolated child conversations. The `subagent` tool provides agent discovery, asynchronous delegation, live steering and inspection, blocking result collection, recursive delegation, cancellation, and explicit cleanup.

## Feature overview

- **Parallel, non-blocking delegation** lets Pi hand off focused tasks and keep working while they run.
- **Stateful follow-ups** preserve each subagent's context so completed work can continue without starting over.
- **Live visibility and control** provide progress, recent activity, steering, and cancellation while work is running.
- **Recursive delegation** lets subagents coordinate their own children under shared ownership and concurrency limits.
- **Context-efficient tooling** uses a compact, purpose-built schema for precise delegation and lifecycle control with minimal context overhead.
- **Built-in management** brings status, results, follow-ups, cleanup, and settings together in `/subagents`.

## Define agents

Agent markdown is discovered from `${PI_AGENT_DIR ?? ~/.pi/agent}/agents` and the nearest project `.pi/agents`. Project definitions override same-named user definitions.

```markdown
---
name: scout
description: Read-only codebase reconnaissance
model: anthropic/claude-sonnet-4
tools: read, bash
---

Inspect the repository and return concise, evidence-backed findings.
```

| Frontmatter | Required | Meaning |
| --- | --- | --- |
| `name` | yes | Runtime agent name. |
| `description` | yes | Nonblank discovery summary. |
| `model` | no | `provider/model` or an unambiguous model ID. |
| `thinking` | no | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. |
| `tools` | no | Comma-separated allowlist; include `subagent` for recursive delegation. |
| `skills` | no | Comma-separated default skills. A spawn value replaces this list. |

The body becomes the child system prompt. Every spawn requires `agent`, `prompt`, and a nonblank `label`. Duplicate labels are allowed; `subagentId` remains the unique handle. Entries may override model, thinking, working directory, and skills.

## Tool actions

| Action | Behavior |
| --- | --- |
| `agents` | List available agent definitions. |
| `list` | List direct children, with a minimal read-only descendant tree. Filter direct children with `statuses` and/or caller-relative `collected`. |
| `spawn` | Start an ordered batch of labelled subagents asynchronously. |
| `resume` | Continue an eligible subagent that retained a resumable session. |
| `steer` | Send messages to running direct children. |
| `cancel` | Idempotently settle direct children as cancelled while retaining context and partial results. |
| `inspect` | Return bounded current status, configuration, and progress for any descendant without waiting or collecting. |
| `join` | Actively wait for and collect a direct child's model result. It blocks while active and is idempotent after collection. |
| `remove` | Permanently remove inactive direct-child subtrees, including uncollected results. An active descendant rejects removal. |

Live-subagent results include the latest one-based `generation`, its `initiatedBy` actor (`user` or `model`), and `actionHints`: snapshot-derived suggestions that may become stale as the subagent changes state. `status` and caller-relative `collected` describe that generation; resuming keeps the same `subagentId`, increments `generation`, and starts a new pair of collection receipts.

A caller can inspect any subagent in its descendant tree, but can mutate only its direct children. Top-level subagents belong to the main Pi session, while recursively delegated work remains under its immediate parent.

## How subagents work

Subagents are context-isolated Pi conversations created from reusable agent definitions. They share the working filesystem with the main session, but keep their own prompts, tools, and conversation history.

### Parallel delegation

Delegated work starts asynchronously, allowing Pi to launch several focused tasks and continue working while they run. Each task streams its own progress and recent activity. When a model result is needed, Pi uses `join` to wait for that specific subagent and collect its current result.

### Follow-up work

A subagent keeps the same identity and conversation context after finishing. Resume becomes eligible when the actor that initiated the generation has collected it; collection by the other actor is neither required nor sufficient. After that receipt, either the user or model may resume the conversation with a follow-up prompt. Follow-ups appear as successive generations in the subagent's history.

### Live progress and control

Running work can be inspected without interrupting it. Pi can also steer a subagent with an additional message or cancel work that is no longer needed. Cancellation retains any reusable context and partial diagnostics, but cannot undo external side effects that have already occurred.

### Recursive delegation

Subagents can delegate work to children of their own. Ownership follows the delegation tree, and concurrency is shared across the entire tree so nested work follows the same limits as top-level work.

### Skills

Every subagent has a child-only `load_skill` tool that accepts one exact skill name. The catalog is deliberately omitted from child prompts; a parent must provide the name. Skills marked `disable-model-invocation` return the same unknown-skill result as an absent name, while agent-definition and spawn `skills` lists may still explicitly preload their full bodies into the child system prompt. Loaded skill references remain ordinary filesystem paths.

The first child inherits the main session's effective skill metadata, including configured, package, CLI, and `resources_discover` additions that Pi reports at `before_agent_start`. Nested and resumed children retain that catalog. A child started in another cwd also discovers Pi's default, settings, and package paths for that cwd. Pi's SDK does not expose the original CLI `--skill` paths or re-run dynamic resource discovery as a standalone catalog operation, so cwd-dependent CLI/dynamic additions are inherited from the parent snapshot rather than recalculated for the child's cwd. Catalog changes made after a child is created apply to later spawns, not that retained conversation.

### Results, receipts, and cleanup

Each generation has separate user and model collection receipts. The model's `join` action records only the model receipt; selecting a conversation in `/subagents` records only the user receipt, immediately for a terminal generation or when selected active work later becomes terminal. There is no separate **Collect** button. Every final result returned by `join` includes `output`, using `null` when the generation produced no text.

Notification, inspection, subscription, active waiting, and collection are distinct states. Being notified, inspecting a conversation, or subscribing to completion does not collect its result. Steering user-initiated work subscribes the model to completion, but does not make the model a required collector for resume.

Removal permanently deletes an inactive subagent and all descendants and may discard uncollected results. Active work rejects removal. Collection applies to the current generation; historical exact-generation collection is not supported.

## Capacity and UI

Concurrency is shared across the recursive tree. `maxConversations` defaults to `100`; new spawns are rejected at capacity until subagents are removed. Existing subagents can still be inspected, collected with `join`, resumed when eligible, or removed.

Settings are stored at `${PI_AGENT_DIR ?? ~/.pi/agent}/subagent/settings.json`. `/subagents` opens the inventory, agent browser, and settings UI; `Ctrl+Alt+A` toggles that UI without typing the command. Selecting a conversation handles the user collection receipt automatically; there is no separate **Collect** action. If another extension claims the shortcut, Pi reports the conflict and `/subagents` remains available. The overlay retains a **Previous generations** section, while `inspect` exposes the same generation-native history with bounded metadata and without outputs.

The widget defaults to summary mode. Progress mode shows queued/running rows up to the configured limit.

Cost displays show reported model cost, accumulated across every generation in the retained conversation. Descendant conversations remain separate. `$0.0000` means reported cost was zero, which may indicate either free usage or unavailable pricing.

After the first subagent starts, Pi's default footer shows `subs $0.0000`. This session total increases with every conversation, including nested conversations, and does not decrease when retained conversations are removed.

## Notifications

Pi notifies you when delegated work finishes unless you already have awareness of it or have collected it. Model-initiated generations also report completion directly to the model. Generations started or resumed by the user in `/subagents` do not wake the model; instead, Pi adds a compact shared-workspace activity notice to the model's next natural turn. If the model steers that work, it subscribes to eventual completion without becoming a required collector. Listing remains read-only; inspection acknowledges what was inspected but neither inspection nor notification collects a result or subscribes the model. Cancelling work also suppresses a redundant completion notification.
