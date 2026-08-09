# 01 — Display realtime subagent session cost

**What to build:** Show each new-system subagent's cumulative model cost while it runs and after it finishes. The display must report session spend, not merely the cost of the latest API call.

**Blocked by:** None — can start immediately.

**Status:** needs-triage

## Current behavior

`extensions/subagent/activity.ts` receives assistant-message `Usage` values containing `usage.cost`, then emits a realtime `"usage"` update. The new implementation stores only the latest API-call usage and renders token counts, elapsed time, turns, and tools. It does not render monetary cost.

The latest usage cannot be used as session spend: input and cache tokens describe the full context sent for that API call and would be double-counted if summed naively. Cost must be accumulated per assistant API response.

## Acceptance criteria

- [ ] Track cumulative cost for every assistant API response in a generation, including responses surrounding tool calls, retries, errors, and compaction where usage is reported.
- [ ] Track cumulative cost across all generations in one conversation, including resumed generations.
- [ ] Preserve latest-call usage separately for current context/token metrics; do not replace it with a naive cumulative token sum.
- [ ] Expose cumulative cost through `GenerationSnapshot` and inspection/render view models without breaking existing latest-usage semantics.
- [ ] Emit cost changes through the existing realtime usage-update path after each assistant `message_end` carrying usage.
- [ ] Display cost in `/subagents` conversation rows and detail view.
- [ ] Display cost in progress-widget rows while a subagent runs.
- [ ] Display cost in `inspect` and `join` results, including partial realtime join updates.
- [ ] Show per-conversation cost only; do not implicitly add descendant costs and double-count nested delegation.
- [ ] Add shared cost formatting with stable precision, such as `$0.0123`; define behavior for zero-priced or unavailable model pricing.
- [ ] Keep display correct for cancelled, interrupted, failed, and resumed generations.
- [ ] Add focused tests covering per-call accumulation, generation totals, resumed conversations, tool-loop updates, realtime rendering, zero-cost models, and failure/cancellation paths.
- [ ] Update `extensions/subagent/README.md` or relevant UI documentation with cost semantics.

## Design constraints

- `Usage.cost.total` is the spend for one reported model call. Sum cost components across calls; do not sum latest context tokens as if they were spend.
- Existing `"usage"` conversation updates already provide the required realtime trigger. No polling or separate process is needed.
- Cost display must remain useful when providers report zero pricing, while avoiding claims of exact spend when pricing data is unavailable.
- Child model cost belongs to the child conversation. Parent and descendant costs should remain separately attributable.

## Relevant code

- `extensions/subagent/activity.ts`
- `extensions/subagent/conversation.ts`
- `extensions/subagent/command/overlay.ts`
- `extensions/subagent/widget.ts`
- `extensions/subagent/tool.ts`
- `extensions/subagent/tool-renderer.ts`
- `extensions/subagent/generation-format.ts`

## Comments
