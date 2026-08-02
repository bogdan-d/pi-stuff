# 01 — Allow ephemeral custom subagents

**What to build:** The parent agent can launch a one-off subagent when no configured subagent fits. It supplies a focused custom role prompt and task, while the child keeps the existing isolation, tool, lifecycle, and workspace-safety behavior.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] A separate `custom_subagent` tool accepts required `rolePrompt`, `task`, and explicit `writes` values.
- [ ] The tool supports optional display `label`, `model`, `thinking`, and `cwd` values; omitted model/thinking inherit the parent selection.
- [ ] Explicit model and thinking values use existing formats; an unavailable explicit model fails instead of silently falling back.
- [ ] Custom runs support foreground/background execution, cancellation, result retrieval, inspection, and `allowConcurrentWrites`.
- [ ] Custom runs use the active child tools and current workspace, with standalone/no-further-subagent guidance and no skills.
- [ ] Explicit `writes` values participate in existing write-admission and concurrent-write protection.
- [ ] The optional label appears in run results and history; the full role prompt is not persisted in history.
- [ ] The tool description gives concise advisory model/thinking guidance: `openai-codex/gpt-5.6-luna` with `low` for bounded exploration, `openai-codex/gpt-5.6-terra` with `low` for broad exploration, and the parent model/thinking for planning, implementation, verification, or review.
- [ ] Focused tests and README/configuration documentation cover the custom invocation, safety boundaries, lifecycle, and model guidance.
