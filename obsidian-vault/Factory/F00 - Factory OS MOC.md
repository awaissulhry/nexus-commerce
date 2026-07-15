# F00 - Factory OS MOC

> **What is this?** Nexus **Factory OS** is a local-first platform running a small Italian leather/motorcycle-apparel factory end-to-end — Gmail thread → quote → order → production → materials → shipping → financials → analytics. A separate app (`apps/factory/`, SQLite) in the same monorepo as [[00 - Nexus Commerce MOC|Nexus Commerce]]. All 11 pages shipped (F0→FP11); the current era is the **Enterprise Program**: page-by-page hardening by parallel sessions.
>
> **How to use this vault section:** start at [[F01 - Mission & Golden Flow]] for the why, [[F06 - Enterprise Program (EP)]] for the how, [[F09 - Roadmap & Owner Gates]] for what needs deciding NOW. Open **`Factory OS Map.canvas`** for the visual wiring and **`EP Status Board.canvas`** for status at a glance. ⚠ The vault is the *map*; the repo docs in `docs/factory/` are the *territory* (canonical, always win) — PLAYBOOK.md first, ENTERPRISE-PROGRAM.md second.

## Foundations

- [[F01 - Mission & Golden Flow]] — why it wins, the flow that IS the product
- [[F02 - Architecture & Stack]] — Next 16 + worker + SQLite WAL + SSE, verification discipline, traps
- [[F03 - Design Law]] — DS copy, the sacred rail, quality bar, escalation ladder
- [[F04 - Domain Model & Money Invariants]] — cents, folds, append-only ledgers, RBAC
- [[F05 - Decision Register (FD1-14)]] — settled decisions; never re-litigate

## The program (current era)

- [[F06 - Enterprise Program (EP)]] — control tower: protocol, claim registry, substrate ownership
- [[F07 - Sessions & Coordination]] — how parallel sessions avoid collisions; active handshakes
- [[F08 - Research Map & Gaps]] — research done vs remaining, ⚠ flags
- [[F09 - Roadmap & Owner Gates]] — everything awaiting the Owner + build order

## The 12 pages (golden-flow order)

| Flow | Page | Status |
|---|---|---|
| 1 · front door | [[F10 - Inbox (EPI)]] | 🟡 awaiting gate |
| 2 · money mouth | [[F11 - Quotes (EPQ)]] | 🔨 EPQ.1 shipped, EPQ.2 next |
| 3 · operational board | [[F12 - Orders (EPO)]] | 🟡 awaiting gate |
| 4 · the floor | [[F13 - Production (EPP)]] | ⚪ open |
| 5 · the ledger's face | [[F14 - Materials (EPM)]] | ⚪ open |
| feeds 2 · pricing model | [[F15 - Products & Pricing (EPD)]] | ⚪ open |
| feeds 1-2 · the parties | [[F16 - Contacts (EPC)]] | ⚪ open |
| 6 · out the door | [[F17 - Shipping (EPS)]] | ⚪ open |
| 8 · money truth | [[F18 - Financials (EPF)]] | 🟡 awaiting gate |
| 9 · the rhythm | [[F19 - Analytics (EPA)]] | ⚪ open |
| config & team | [[F20 - Settings & Team (EPT)]] | ⚪ open |
| internal comms | [[F21 - Chat & Order Spaces (FC)]] | ⚪ FC1 spec next |

## Substrate & sources

- [[F22 - Substrate FS Series]] — FS0-FS5: harness, SSE (✅), virtualization (✅), write integrity, storage
- [[F26 - AWA Workbook (structure)]] — 🔒 the Owner's ledger, structure-only; drives EPF.3
- Canonical repo docs: `docs/factory/PLAYBOOK.md` (entry point) · `ENTERPRISE-PROGRAM.md` (registry) · `F0-*.md` (canon) · `FPn-SPEC/REPORT` (as-built) · `EPx-PROPOSAL/UI-INVENTORY` (hardening)

## Vault maintenance contract

Any session that changes a page's status **updates that page's note + the registry snapshot in [[F06 - Enterprise Program (EP)]] + the status canvas**, committing `obsidian-vault/Factory/` with `--only` alongside its docs commit. One line of truth per fact: detail lives in repo docs; the vault holds purpose, status, and wiring.
