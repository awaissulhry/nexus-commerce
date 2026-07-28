# Project Map

**Purpose:** orient a human or an AI assistant in this repo before they go looking for anything.
**Generated:** 2026-07-28 from repo state (file counts + last-commit dates per area).

This repo has **506 tracked markdown files** across four locations. Roughly a
fifth of them describe work that was abandoned in April 2026. This file exists
so nobody — and no assistant — wastes a session reading the dead fifth.

---

## Start here, by question

| If you want to know… | Read |
|---|---|
| How the whole system fits together | `obsidian-vault/00 - Nexus Commerce MOC.md` |
| How a specific subsystem works | `obsidian-vault/NN - <topic>.md` (numbered 01–27) |
| The Factory OS side of the product | `docs/factory/PLAYBOOK.md` — **read before touching Factory** |
| What's broken / owed | `TECH_DEBT.md` (repo root) |
| How to ship to production | `docs/GO-LIVE.md` |
| Design system rules | `docs/DESIGN-SYSTEM.md`, `docs/UI_REBUILD_STRATEGY.md` |
| A recent implementation plan | `docs/superpowers/plans/YYYY-MM-DD-<slug>.md` |

---

## The four documentation locations

### 1. `obsidian-vault/` — 59 notes · **live** (last touched 2026-07-28)

The best-maintained area, and the best place to start. Numbered, indexed, and
genuinely current.

- `00 - Nexus Commerce MOC.md` — map of content, the front door
- `01`–`27` — one note per subsystem (architecture, API, DB, jobs, real-time,
  web app, design system, Amazon SP-API, eBay, Shopify, products, listings,
  inventory, orders, pricing, advertising, marketing, reviews, analytics,
  bulk ops, auth, shared packages, bidding engine)
- `28`–`32` — current ads research and specs (eBay ads strategy, eBay Ads
  Cockpit EA-series, Amazon Ads platform audit, competitor teardown,
  import/export sync spec)
- `Factory/F00`–`F26` — Factory OS, with its own MOC at `F00`

Auto-commits every 5 minutes via `scripts/vault-autocommit.sh`; commits titled
`vault: auto-commit <timestamp>` are that timer, not a person.

### 2. `docs/` — 333 files · **mixed, read the split below**

Live subdirectories:

| Path | Files | Last touched | What it is |
|---|---|---|---|
| `docs/ads-amazon/` | 2 | 2026-07-28 | Amazon Ads — **hottest area** |
| `docs/ads-ebay/` | 32 | 2026-07-28 | eBay Ads cockpit (EA-series) |
| `docs/superpowers/plans/` | 65 | 2026-07-26 | dated implementation plans, newest-first by filename |
| `docs/factory/` | 79 | 2026-07-17 | Factory OS — `PLAYBOOK.md` and `ENTERPRISE-PROGRAM.md` are canonical |
| `docs/flat-file/` | 12 | 2026-07-06 | flat-file substrate |
| `docs/security/` | 17 | 2026-07-03 | RBAC, permissions manifest, auth |

Live top-level runbooks and specs worth knowing:

`GO-LIVE.md` · `SYNC-CONTROL.md` · `AMAZON-BULKSHEET-SCHEMA.md` ·
`AMAZON_DATA_STRATEGY.md` · `MARKETING-OS.md` · `RANK_DIRECTOR.md` ·
`DESIGN-SYSTEM.md` · `UI_REBUILD_STRATEGY.md` · `edit-ux.md` ·
`ebay-import-runbook.md` · `xlsm-hybrid-runbook.md` ·
`flat-file-trust-runbook.md` · `AX-IE-0-1-PLAN.md` · `AMS-SETUP.md`

### 3. `plans/` — 50 files · ⚠️ **historical, last touched 2026-04-27**

Nothing here has been modified in three months. It documents an earlier product
direction and should not be treated as current intent:

- `PHASE1`–`PHASE20` — superseded numbering scheme
- `RITHUM-*` and `rithum-architecture-study*` (11 files) — competitor
  architecture study, research only, never implemented
- `PHASE3-WOOCOMMERCE-IMPLEMENTATION.md`, `PHASE4-ETSY-IMPLEMENTATION.md` —
  channels that were never launched

Keep for history. Do not plan from it.

### 4. Repo root — 7 files

`TECH_DEBT.md` (the canonical prioritized backlog) · `DEVELOPMENT.md` ·
`SITE_AUDIT.md` · `REPLENISHMENT.md` · `AMAZON_API_AUTHORIZATION.md` ·
`PHASE_B_VERIFICATION.md` · `RESTORATION_NOTES.md`

> Note for AI assistants with folder-scoped access: root is often **not** granted,
> because granting it exposes a 40 GB tree (`node_modules`, a 3.7 GB `.git`).
> If you cannot see `TECH_DEBT.md`, that is why — ask for it explicitly.

---

## Known traps

**`docs/README.md` is stale and misleading.** Dated 2026-04-23, it presents
itself as the documentation front door but describes integrating **Shopify,
WooCommerce and Etsy**. Commit activity since April is almost entirely Amazon
and eBay. Do not use it for orientation — use this file.

**50 `docs/PHASE*.md` files are dead.** Last touched 2026-04-27, same abandoned
numbering as `plans/`. Combined with `plans/`, that is ~100 files of the 506
that describe superseded work.

**Current work uses letter-series codes, not phase numbers.** AX (Amazon Ads),
EA (eBay Ads), EP\* (Enterprise Program: EPI inbox, EPQ quotes, EPO orders,
EPF financials), FS/FC (Factory scale/chat), SC (sync control), RX
(replenishment), RD (rank director). A doc numbered `PHASE12F` is from the old
scheme; a doc referencing `AX-IE` or `EPQ.2` is current.

---

## Maintaining this file

Regenerate the counts and dates with:

```bash
for d in docs/factory docs/superpowers docs/ads-ebay docs/ads-amazon \
         docs/security docs/flat-file plans obsidian-vault; do
  printf '%-24s %4s files  last %s\n' "$d" \
    "$(git ls-files "$d" | wc -l | tr -d ' ')" \
    "$(git log -1 --format=%ad --date=short -- "$d")"
done
```
