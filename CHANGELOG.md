# Changelog

## 0.1.1

- Preserve native provider registrations while accounts applies authentication overlays, including pi-codex-conversion streaming and model behavior.
- Resolve native-provider request auth and refresh from the selected account store, including direct compaction calls. Selected-account failures do not fall back to standalone OAuth.
- Restore native or legacy registrations after removal and failed replacement. Do not overwrite another extension's replacement during fail-closed handling.
