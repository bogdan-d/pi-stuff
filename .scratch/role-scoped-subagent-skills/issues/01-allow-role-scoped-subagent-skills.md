# 01 — Allow role-scoped skills in subagents

**What to build:** Subagents keep skills discovery disabled, while built-in roles and custom agents receive a small, explicit skill allowlist. Skill names resolve from the parent catalog, load on demand, and never broaden to all discovered skills.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] Child launches retain `--no-skills` and add only resolved `--skill` paths.
- [ ] Built-in role defaults match the approved mapping: planning uses `codebase-design` and `domain-modeling`; implementation uses `tdd` and `ponytail`; verification uses `diagnosing-bugs` and `adversarial-qa`; review uses `code-review` and `agent-native-hardening`; exploration roles use no skills.
- [ ] Custom agents accept optional `skills: string[]` values that add to their role defaults.
- [ ] Custom-agent add, edit, clone, persistence, and validation flows support the skills field.
- [ ] Skill names resolve against the parent skill catalog for the current working directory and settings.
- [ ] Missing skill names warn and do not prevent the child from launching.
- [ ] No per-call skill parameter is added; selected skills remain progressive and on-demand.
- [ ] Focused tests and README/configuration documentation cover the behavior.
