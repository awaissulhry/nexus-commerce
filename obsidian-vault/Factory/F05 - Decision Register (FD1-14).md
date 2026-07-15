# F05 - Decision Register (FD1-14)

> Canonical: `docs/factory/F0-DECISIONS.md` — all approved as recommended. **Never re-litigate**; Owner-input-still-open items marked ⚠.

Hub: [[F00 - Factory OS MOC]]

| # | Decision | Notes |
|---|---|---|
| FD1 | Code lives in monorepo `apps/factory`, own SQLite DB | disjoint paths + scoped commits |
| FD2 | One Next.js 16 app (:3100) + sidecar worker + Prisma 7 pinned + SQLite | Tauri v2 packaging later |
| FD3 | Gmail label-scoped ingestion + reconciliation sweep | Owner currently runs whole-INBOX scope; re-scope any time in Settings |
| FD4 | Drive per-party/order folders `Factory/{Party}/{ORD-n}/` | not a bulk-media store |
| FD5 | WhatsApp deferred | ⚠ decided at FP11: recommendation = defer channel, Meta Cloud API when volume justifies; `Conversation.channel` is ready |
| FD6 | First carrier = Sendcloud | ⚠ plan capability probe at build time (Lite-vs-Growth tracking boundary is empirical) |
| FD7 | Pricing = sparse per-price-list option deltas over the default list; **cost side global** | margin honesty — see [[F04 - Domain Model & Money Invariants]] |
| FD8 | Immutable movement ledger, lot-aware, compensating corrections | no contest |
| FD9 | Full auth schema day one; OWNER + WORKER seeded; RBAC shadow→**enforce** | OFFICE/ACCOUNTANT role = later permission-list edit (⚠ pending as EPF D-10) |
| FD10 | Gmail consent: External + published to Production (unverified personal-use path) | Testing mode = 7-day token trap |
| FD11 | Jobs in the sidecar worker process | never in `instrumentation.ts` |
| FD12 | Design system = verbatim copy + parity check | [[F03 - Design Law]] |
| FD13 | Deposit gate ON for one-off customer orders, OFF for established B2B | ⚠ Owner input open: default %, which segment bypasses (also EPF D-11) |
| FD14 | EN 17092 compliance built-in: cert registry + QC gate + DoC | near-zero-cost differentiator |

**EP-era decisions in flight** (each page's D-numbers): [[F11 - Quotes (EPQ)]] D-1..D-5 (approved; D-4 deferred to EPQ.5) · [[F12 - Orders (EPO)]] D-1..D-6 (awaiting gate) · [[F18 - Financials (EPF)]] D-1..D-12 (awaiting gate) · [[F10 - Inbox (EPI)]] 5 decisions (awaiting gate). Roll-up: [[F09 - Roadmap & Owner Gates]].
