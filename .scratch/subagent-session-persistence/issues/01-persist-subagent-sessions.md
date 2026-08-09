# 01 — Persist subagent sessions

**What to build:** Allow the new `extensions/subagent` implementation to opt into durable child sessions. Persist each child conversation as a Pi session JSONL file so its complete history can be inspected and resumed after the parent Pi process restarts.

**Blocked by:** None — design decisions below need maintainer confirmation.

**Status:** needs-triage

## Current behavior

`extensions/subagent/execute.ts` creates every child with `SessionManager.inMemory`. The runtime retains child `Conversation` objects only in the current process. The parent session receives only a compact `subagent-generation-index` custom entry when a generation finishes; it does not contain the child session history or child tool-call timeline.

## Acceptance criteria

- [ ] Add an opt-in persistence setting for child sessions; the existing in-memory behavior remains the default until the setting is enabled.
- [ ] Persist each child session through `SessionManager.create(...)` in a dedicated, documented subagent-session directory rather than mixing child files into the parent session directory by accident.
- [ ] Persist the complete child Pi session JSONL, including user and assistant messages, tool calls and tool results, model/thinking changes, compaction entries, and extension custom entries supported by the SDK.
- [ ] Persist enough subagent metadata to reconstruct the child after restart: stable `subagentId`, generation history, agent definition/configuration, working directory, model, thinking level, skills, parent relationship, label, and session-file path.
- [ ] Rehydrate persisted child conversations when the parent session or extension starts, without treating historical children as active work.
- [ ] Allow a rehydrated child to resume through the existing `resume` action while preserving its stable `subagentId` and generation history.
- [ ] Expose the child session-file path through `inspect` or the `/subagents` UI so users can analyze the raw JSONL independently.
- [ ] Keep persisted child files available after completion, cancellation, and parent-session reload until explicit subagent removal or configured cleanup removes them.
- [ ] Make `remove` delete the corresponding persisted child session files and metadata only after the existing inactive-subtree checks pass.
- [ ] Preserve recursive delegation, steering, joining, cancellation, concurrency limits, and session-switch guards in both memory and persistent modes.
- [ ] Prevent stale, malformed, missing, or definition-incompatible persisted records from blocking parent startup; report bounded diagnostics and leave invalid records recoverable or removable.
- [ ] Add focused tests for persistence opt-in, JSONL contents, restart rehydration, resume-after-restart, nested children, cleanup, malformed records, and default in-memory behavior.
- [ ] Document storage location, retention, privacy implications, configuration, recovery behavior, and raw JSONL analysis workflow in `extensions/subagent/README.md`.

## Design constraints

- Child sessions must remain context-isolated from the parent; persistence must not inject child messages into the parent model context.
- Parent `subagent-generation-index` entries may remain as compact discovery metadata, but cannot be the only source required for full child recovery.
- Persisted sessions must use the child working directory and the same effective resource/tool configuration needed for a later resume.
- Full child history can contain prompts, tool inputs, tool outputs, and workspace-sensitive data. Storage and cleanup behavior must be explicit.

## Open decisions

- Exact setting name and whether persistence is global, per parent session, or per spawn.
- Default directory and whether users can configure a custom directory.
- Whether rehydration is automatic for the current parent session only or can discover sessions independently.
- How agent-definition changes are handled when resuming an older child session.
- Whether persisted child sessions need an explicit export/analyze command beyond exposing their JSONL path.

## Comments
