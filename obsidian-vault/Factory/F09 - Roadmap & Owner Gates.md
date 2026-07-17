# F09 - Roadmap & Owner Gates

> Everything currently **waiting on the Owner**, plus the sensible build order. The double gate is law: nothing builds without approval; each phase re-gates.

Hub: [[F00 - Factory OS MOC]] · status board: `EP Status Board.canvas`

## 🔔 Awaiting the Owner right now

| Gate | What's asked | Where |
|---|---|---|
| **FS4 spec** | Gate `FS4-SPEC.md` (write integrity — generalizes EPO.1's `expectedUpdatedAt` pattern house-wide) | [[F22 - Substrate FS Series]] |
| **Per-phase click-throughs** | EPQ.1/.2 · EPI.1 · EPO.1/.3/.2 gate reports await the Owner's click-through confirmations; ⚠ **restart the `:3100` dev server** (trap 6b — new columns from EPI.1/EPO/EPF.1 migrations) | each report |
| ~~EPI · EPO · EPF proposals · FC1 spec~~ | ✅ ALL APPROVED (EPI+FC1 2026-07-16; EPO 2026-07-16; EPF 2026-07-17 "proceed however you recommend") — building | — |
| FP11 leftovers | Flip RBAC `enforce` on :3100 · settle WhatsApp (FD5) | [[F20 - Settings & Team (EPT)]] |
| FD13 params | Deposit % defaults + bypass segment | [[F05 - Decision Register (FD1-14)]] |
| Sendcloud live step | Connect + one €0 label (capability probe) | [[F17 - Shipping (EPS)]] |

## In flight (no gate needed)

- **EPF.1 SHIPPED 2026-07-17** (`EPF1-REPORT.md`) — the P0 money bugs are dead and EPO.2's board shows correct balances (B3 closed); ⚠ Owner: **restart `:3100`** then run the click-through — [[F18 - Financials (EPF)]]. **EPF.2 next** in this session.
- **EPQ.3** next (quotes session) · **EPI.2** next (inbox session) · **EPO.4** next (orders session, fulfillment-exceptions scope per M2) · **FC1** building (worktree).
- **FS3 call-site adoptions** land inside each page's phases (EPI ✅ pane hook in EPI.1; EPO.7, EPQ.3/.6, EPF.2 pending).

## Recommended sequencing (dependency-aware)

1. **Gate the three proposals** (EPI/EPO/EPF) — they're independent reads, and every week ungated leaves the EPF P0 money bugs live.
2. **EPO.1 + EPF.1 first among builds** — both are integrity repairs (state-machine truth; money truth). EPO.1's `transition-service` unblocks correctness for [[F13 - Production (EPP)]]/[[F17 - Shipping (EPS)]] later; EPF.1 stops the wrong accountant CSV and negative balances.
3. **FC1 spec** after FS2-dependent work settles — unlocks the internal half of "no communication gap"; EPO.6/EPI.6 scaffold its seams.
4. **FS4/FS5** when a page session hits their pain directly (write races → FS4; search/attachments at scale → FS5).
5. **Remaining pages claimed opportunistically** — Production and Shipping benefit most from landing AFTER EPO.1 (they consume the transition-service); Contacts after EPF.3/EPQ.5 add party money+tax fields; Analytics after more folds exist to visualize; Settings last (it accretes every page's config).

## The gate ritual (unchanged)

Research → proposal → **Owner approval** → phase spec → build (scoped commits, tests, harness re-run) → click-through script → **Owner approval** → registry row updated → next phase. Honest gate reports; defects out of scope are FLAGGED, never silently fixed.
