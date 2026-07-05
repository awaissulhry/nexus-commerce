# FP3 — Quotes: build report (gate 2, awaiting Owner click-through)

Shipped 2026-07-05 against the approved `FP3-SPEC.md`. Five commits (FP3.1 quote CRUD + engine compose → FP3.2 pipeline + configurator → FP3.3 PDF + send + Inbox wiring → FP3.4 public accept + convert + recall + export → FP3.5 verify). **Quotes is live at `/quotes`, and the golden flow's first half is closed.** Built on Opus 4.8 per the Owner's instruction. Additive migration `fp3_quotes`; one dependency (`pdfkit`); no commerce surface touched.

## Eng trans

The two halves you already had now join into the thing the whole product was justified on. From a matched Gmail thread you click **New quote** in the context rail; the configurator opens with the customer locked and their price list loaded. You tick options and the price, cost and **margin** compose live — the same engine from FP2, but now writing a real quote. You set a deposit and a validity date, add a manual adjustment with a reason if you're negotiating, and hit **Send**: a professional **PDF in Italian** (with line prices and **never any cost or margin**) is emailed as a reply *into the same thread*, and the send is frozen forever as a version — even if you later change a template or a material cost, that sent quote never moves. A red speed-bump stops you sending below your margin floor without a deliberate tick.

The customer opens a link in that email and **accepts with one click** — no login, no portal — and your bell rings; or you mark it accepted yourself if they just reply "yes." Then **Convert to order** turns the acceptance into an Order. The pipeline tracks every quote as Draft / Sent / Accepted / Rejected with three live counters, the rail shows similar past quotes (won/lost) to anchor your pricing, and everything exports to CSV.

## What was verified (headless, isolated :3199, real persisted data, NO live email)

The golden flow was driven end to end and every number checked against the engine:

| Check | Result |
|---|---|
| Quote created | numbered Q-n, deposit from party default, 30-day validity, lead-time promise date ✓ |
| Line configured (Kangaroo) | net €520 / cost €290 / margin €230 — matches the FP2 engine exactly ✓ |
| qty ×2 / adjustment −€40 | totals €1040 / €480, reason persisted ✓ |
| PDF renders | HTTP 200, valid `%PDF`, ~2 KB (built only from the cost-free snapshot) ✓ |
| Margin-floor guard | send below floor without acknowledgement → 422 with the exact margin in the message ✓ |
| Convert accepted quote | ORD-1 created, quote badged converted; second convert → 409 ✓ |
| Export | quotes CSV contains the quote ✓ |
| **Public link — customer view** | 200, correct total, **no cost/margin key anywhere** ✓ |
| **Public link — accept** | 200 → quote flips to ACCEPTED; re-accept → 409; bad token → 404 ✓ |
| Snapshot security | `shapeSnapshotLines` unit-tested to emit no cost/margin; a preview payload strips to nothing for a no-grains caller ✓ |

Battery: **96/96 unit tests · 71/71 routes RBAC-covered · no-touch clean · DS parity 97/97 · build + typecheck green · zero page errors.** Editor screenshot reviewed at native resolution (live margin, waterfall, converted banner) — clean and on-token. All test data removed; the quote/order counters were reset (no real quotes exist, so your first is **Q-1 / ORD-1**).

## Bug found and fixed during verification

**Public accept POST returned 403** — my route guard enforces the CSRF double-submit cookie on *all* mutations, but a customer clicking the email link has no CSRF cookie. Fixed by having the public page do the same CSRF handshake the app does (fetch a token first); the unguessable link token remains the real authentication, and CSRF stays uniform across every route (no weakening). Verified: accept now 200 → ACCEPTED.

## Known constraint (flagged, not a defect)

**The public accept link needs the app reachable by the customer's browser.** On pure localhost it isn't, so on your current setup the customer can't click it — which is exactly why the editor also has **manual Mark accepted / Mark rejected** for when they reply in the thread. Set `FACTORY_PUBLIC_URL` (or run on a reachable host/LAN/tunnel) and the one-click accept works. This is the local-first trade-off from F0, surfaced here honestly.

## What lives where

| Surface | Path |
|---|---|
| Engine bridge | `src/lib/quotes/compose-line.ts` (party-scoped compose + rollups), `counters.ts` (Q-/ORD- numbering) |
| Snapshot + PDF | `src/lib/quotes/build-snapshot.ts` (cost-free, unit-tested), `render-pdf.ts` (pdfkit, Italian), `public.ts` |
| API (18 routes) | `src/app/api/quotes/*` (list/create/[id]/lines/send/convert/pdf/similar), `q/[token]/*` (PUBLIC), `exports/quotes`, `settings/pricing-defaults` |
| UI | `src/app/(app)/quotes/_components/*` (QuotesClient pipeline, QuoteEditor configurator, SendModal, ConvertBar), `src/app/q/[token]/page.tsx` (public) |
| Inbox wiring | `inbox/[id]` returns linked quotes; `ContextRail` New-quote action + quotes card |

## Deviations from spec (flagged)

1. **Public accept link requires a reachable app** (above) — the mechanism is complete; reachability is deployment. Manual accept/reject covers localhost.
2. **Deposit on convert is not a Payment record** — the Order links to the quote (which carries `depositPct`); real payment/deposit tracking is FP9. The convert audit notes the deposit.
3. **PDF text verification is by-construction + unit test**, not by-parsing the compressed PDF stream (pdfkit compresses content) — the snapshot it's built from is proven cost-free, which is the guarantee that matters.

## Your click-through (the FP3 gate)

Needs a template with priced options (make one in Products if you haven't) and a Gmail connection to send.
1. Restart the app. **Inbox** → open an *AWA ORDER* thread → the context-rail **Quotes** card → **New quote** → the configurator opens for that customer.
2. Add a line, pick the product + options; watch net/cost/margin compose and any constraint block; set a deposit and a −€ adjustment with a reason.
3. **Send** → confirm (note the margin-floor bump if you crush the price) → check **Gmail**: the PDF reply threaded into the conversation, with line prices and no cost/margin.
4. Open the customer link from a phone/other browser (if the app is reachable) → **Accept**; or use **Mark accepted** in the editor. Your bell rings.
5. **Convert to order** → "ORD-1 created". The pipeline shows it converted; the rail shows the frozen version's PDF and any similar past quotes.
6. **Export CSV** from the pipeline header.

## Rollback

`git revert` the five FP3 commits (factory-scoped). The migration is additive (four unused Quote columns remain harmless). Delete `apps/factory/data/quotes/` for stored PDFs. No commerce surface involved.

## Deferred (PLAYBOOK backlog)

`FACTORY_PUBLIC_URL` setup UI; deposit as a real Payment (FP9); measurement profiles on quote lines (FP5); quote CSV import; per-brand sender identity on the send; IT/EN PDF toggle per party.

**Next on approval: FP4 — Orders (the board, one-timeline, status management) — where the ORD-1 this cycle created gets its home.**
