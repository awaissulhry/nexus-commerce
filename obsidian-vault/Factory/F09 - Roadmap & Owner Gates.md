# F09 - Roadmap & Owner Gates

> Everything currently **waiting on the Owner**, plus the sensible build order. The double gate is law: nothing builds without approval; each phase re-gates.

Hub: [[F00 - Factory OS MOC]] · status board: `EP Status Board.canvas`

## 🔔 Awaiting the Owner right now

| Gate | What's asked | Where |
|---|---|---|
| ~~EPI proposal~~ | ✅ **APPROVED 2026-07-16** — EPI.1 building; one cross-review amendment owed (fix `?c=`/`?o=` outbound params, B2) | [[F10 - Inbox (EPI)]] |
| **EPO proposal** | Approve 7 phases + D-1..D-6, **with the EP-CROSSREVIEW amendments attached** (EPF.1 gates EPO.2; `import.finished`; order-summary for EPI.6; exception-queue split) | [[F12 - Orders (EPO)]] |
| **EPF proposal** | Approve 7 phases + D-1..D-12 (§9 addendum applies the cross-review + verified compliance) — **3 P0 money bugs are live**; EPF.1 can gate alone first | [[F18 - Financials (EPF)]] |
| **FC1 spec** | Gate the drafted `FC1-SPEC.md` (Order Spaces substrate) | [[F21 - Chat & Order Spaces (FC)]] |
| FP11 leftovers | Flip RBAC `enforce` on :3100 · settle WhatsApp (FD5) | [[F20 - Settings & Team (EPT)]] |
| FD13 params | Deposit % defaults + bypass segment | [[F05 - Decision Register (FD1-14)]] |
| Sendcloud live step | Connect + one €0 label (capability probe) | [[F17 - Shipping (EPS)]] |

## In flight (no gate needed)

- **EPQ.2** building next in the quotes session (view tracking, notifications, follow-up task queue) — [[F11 - Quotes (EPQ)]].
- **FS3 call-site adoptions** land inside each page's phases (EPI.1/.5, EPO.7, EPQ.3, EPF.2).

## Recommended sequencing (dependency-aware)

1. **Gate the three proposals** (EPI/EPO/EPF) — they're independent reads, and every week ungated leaves the EPF P0 money bugs live.
2. **EPO.1 + EPF.1 first among builds** — both are integrity repairs (state-machine truth; money truth). EPO.1's `transition-service` unblocks correctness for [[F13 - Production (EPP)]]/[[F17 - Shipping (EPS)]] later; EPF.1 stops the wrong accountant CSV and negative balances.
3. **FC1 spec** after FS2-dependent work settles — unlocks the internal half of "no communication gap"; EPO.6/EPI.6 scaffold its seams.
4. **FS4/FS5** when a page session hits their pain directly (write races → FS4; search/attachments at scale → FS5).
5. **Remaining pages claimed opportunistically** — Production and Shipping benefit most from landing AFTER EPO.1 (they consume the transition-service); Contacts after EPF.3/EPQ.5 add party money+tax fields; Analytics after more folds exist to visualize; Settings last (it accretes every page's config).

## The gate ritual (unchanged)

Research → proposal → **Owner approval** → phase spec → build (scoped commits, tests, harness re-run) → click-through script → **Owner approval** → registry row updated → next phase. Honest gate reports; defects out of scope are FLAGGED, never silently fixed.
