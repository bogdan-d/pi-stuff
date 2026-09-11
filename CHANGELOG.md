# Changelog

## 0.2.0

- Save and switch between named API keys per provider through `/accounts`, including Z.AI for GLM. Discover API-key login providers from Pi and offer a method choice alongside supported OAuth logins.
- Offer the target provider's model picker when switching accounts across providers. Same-provider switches keep the current model.
- Preserve Pi's default login and existing OAuth accounts. Restore the original native auth resolver before removing a runtime key so default-account switching can synchronize successfully.

## 0.1.1

- Preserve native provider registrations while accounts applies authentication overlays, including pi-codex-conversion streaming and model behavior.
- Resolve native-provider request auth and refresh from the selected account store, including direct compaction calls. Selected-account failures do not fall back to standalone OAuth.
- Restore native or legacy registrations after removal and failed replacement. Do not overwrite another extension's replacement during fail-closed handling.
