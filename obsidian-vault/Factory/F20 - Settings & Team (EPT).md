# F20 - Settings & Team (EPT)

> **Route:** `/settings` · **EP code:** EPT · **Status:** ⚪ open — unclaimed; FP11 base shipped & verified (**closed the original 11-page arc**).
> Canonical docs: `FP11-SPEC.md` / `FP11-REPORT.md` · charter: `F0-IA.md` §11

Part of [[F00 - Factory OS MOC]]

## Charter

Integrations (Gmail/Drive/carrier wizard/WhatsApp-later), team & roles (the RBAC console), import/export center, pricing defaults, stage-pipeline config, VAT default, backup status as a first-class panel (local-first = we are the ops team). Every integration panel states freshness.

## As built (FP11)

`team-service.ts` = the only sanctioned team mutation path (guardrails: last-owner, system-role immutability) · members + invitations → PUBLIC `/join/[token]` accept · **custom roles via the `permissionCatalog()` matrix** · stage-pipeline editor (`production.stages`) · pricing defaults (`pricing.defaults` incl. margin floor) · VAT (`financials.defaults.vatRatePct`) · backup panel over `.snapshots/` · RBAC **enforce verified** on :3199.

## Standing Owner gate steps (from FP11 — still the Owner's)

1. Flip `FACTORY_RBAC_MODE=enforce` on the live `:3100` (verified safe) — **required before any second person gets a login.**
2. Settle WhatsApp (FD5) — recommendation: defer channel, Meta Cloud API when volume justifies.

## Known open items for the future EPT session

- FP11 deferred: in-app backup-restore, global audit viewer (every page's audit trails converge — a natural EPT surface), drag-reorder stages, multi-role-per-user, `events.listen` permission.
- New settings arriving from EP pages accrue here: EPF close/lock-date + dunning ladder config, EPQ follow-up cadence + floor %, EPI views/rules/templates management (EPI builds its own drawers — EPT hosts only global config; watch the boundary).
- The OFFICE/ACCOUNTANT read-only role (FD9, [[F18 - Financials (EPF)]] D-10) would be minted here via the existing matrix.
