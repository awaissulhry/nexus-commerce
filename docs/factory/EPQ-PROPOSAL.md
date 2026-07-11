# EPQ — Quotes at enterprise grade (proposal · gate 1)

First page of the Enterprise Program (`ENTERPRISE-PROGRAM.md`). Sources: F0-TEARDOWN verdicts (citable law), a fresh 2026-07-11 enterprise-CPQ research sweep (Salesforce CPQ/Tacton/Epicor/PandaDoc + Odoo/Katana/MRPeasy/Fulcrum/Cetec/JobBOSS² + apparel-MTM practice), an Italy/EU quote-compliance research pass, and a full line-level audit of the shipped FP3 implementation. Nothing here is built; each phase re-gates.

## 1. What /quotes IS (the purpose, restated so we harden the right thing)

The Quotes page is **the factory's money mouth**: it turns a matched Inbox conversation into a priced, margin-guarded, versioned offer; carries the negotiation; captures acceptance with evidence; and hands production a complete, frozen spec. Its three loyalties, in order: (1) **never quote money the factory regrets** (margin truth, pricing discipline), (2) **never let an offer die of silence or ambiguity** (no communication gap), (3) **never make production guess what was sold** (handoff completeness). Everything below serves one of the three.

## 2. What exists (FP3, verified 2026-07-11)

Pipeline (counters/tabs/search/grid, take-200), configurator on the FP2 engine (constraints BLOCK/WARN, adjustment+reason, deposit %, validity, promise date), per-party price lists auto-applied, margin/cost grain-gated, snapshot-frozen versions on send (customer PDF structurally cost-free), Italian PDF, threaded Gmail send, public tokenized accept/reject with 410 after validity, manual accept/reject, convert→order (lines frozen net+cost), similar-quote recall, CSV export, win/loss with reasons. It is a genuinely strong core — the audit found the *edges* unfinished, not the middle.

## 3. What the audit found (the honest defect list)

**Correctness (fix regardless of any enterprise ambition):**
- S1 EXPIRED is a dead state — no code ever sets it; lapsed quotes sit in SENT forever; analytics counts EXPIRED as loss but can never see one; no Expired tab.
- S2 State machine not forward-only — `[id]` PATCH writes ANY state unconditionally (spec promised forward-only, audited); SENT quotes' deposit/dates also editable via raw API while lines are frozen.
- S3 Re-send after Revise omits the accept link (only the FIRST send mints one) — and the customer's OLD link stays live at v-latest… but the v1 email still reads like an offer. No supersede semantics.
- S4 `marginFloorBreached` never written; the send-time floor acknowledgment isn't persisted — no durable record a below-floor offer was knowingly made.
- S5 Price-change audit logs `{lineId}` only — no before/after money.
- S6 Manual accept/reject/convert notify NO ONE (only the public link rings the bell); quote validity and conversation follow-up are totally unlinked — the worker chases threads but never an aging quote.
- S7 Goal-seek exists in the engine (goalSeekByNet/ByMargin) and in Products preview, but the QuoteEditor rail that promises it never got the control.
- S8 Spec debt: bulk mark-lost absent; three-row waterfall instead of the spec'd four (Adjustment folded invisibly into Net).
- S9 VAT: PDF says "Prezzi IVA esclusa" and computes nothing; Party.currency ignored (EUR hardcoded — fine, but silently).

## 4. Enterprise gap analysis (research verdicts, bloat pre-filtered)

Adopted into phases below: revision compare · supersede semantics · auto-expiry + pre-expiry nudges · follow-up cadence (measured 20-45% close-rate lift in practitioner data) · public-link view tracking · acceptance evidence (eIDAS-simple level) · deposit-payment-on-accept (Owner decision) · request-changes box on the public page · clone-as-draft · margin floor + persisted ack + reason codes · duplicate-open-quote banner · customer tier/quantity-break tables · measurement surcharges · size-run matrix lines (B2B) · structured cost breakdown (leather consumption per style×size + wastage, labor × rate, overhead) · quote-vs-actual loop feeding repeat-order requotes · CTP-lite promise (base + live backlog + leather lead time) · quote-desk KPIs (aging, turnaround, conversion).

Rejected as bloat (recorded so no session re-proposes them): multi-tier approval routing, guided selling, renewal/amendment engines, multi-currency, portal logins, customer self-serve config editing, auto-nesting engines, paid e-sign for quote acceptance.

## 5. The phases (each gated, each testable alone on :3199 + harness)

### EPQ.1 — Lifecycle closed & audited (kills S1-S5, S8-in-part)
Legal-transition map enforced server-side (any illegal transition 422 + audit); worker quote tick: auto-EXPIRE lapsed SENT quotes (Owner-visible, reversible by Revise) + Expired tab + counter; supersede: every send mints a fresh accept token, prior tokens render a "superseded — view current offer" page linking the latest version; SENT field-guard (deposit/dates locked outside DRAFT); persist floor-ack (who/when + marginFloorBreached finally written); before/after money in every line audit; four-row waterfall (Adjustment visible); bulk mark-lost with reason. **Exit:** state machine provably closed under test; no silent transitions anywhere.

### EPQ.2 — No offer dies of silence (kills S6; A3/A4/C1/C4)
View tracking on the public page (open/view events; "Viewed 2×, last Tue" in pipeline + editor); notifications for manual accept/reject/convert and for first-view; the follow-up engine as an **Owner task queue, not auto-send** (recommended): day-N unviewed nudge, day-M viewed-but-silent nudge, pre-expiry alert — each a one-click, editable Italian template that sends INTO the existing Gmail thread; "request changes" box on the public page → lands in the thread + pipeline + bell. Cadence defaults configurable in Settings. Depends on nothing external; worker tick + existing notify(). **Exit:** a quote can demonstrably never age past its checkpoints without the Owner being poked.

### EPQ.3 — Pricing discipline (kills S7; B2/B5/E1/E2/E4/E5)
Goal-seek wired into the rail (net ⇄ margin, engine functions already exist); quantity-break tiers + below-MOQ surcharge tables (per template, shown as Price Source rows); measurement surcharge rules (size threshold → auto surcharge line); repeat-order pricing (recall knows a style was produced before → drops development cost, prefills from actuals once EPQ.4 ships); duplicate-open-quote banner ("Q-1041 open for this party, similar config"); discount reason codes (enum + note) feeding win/loss. Size-run matrix line editor (sizes × qty grid as ONE line, B2B). **Exit:** same-input quotes are reproducible; every price deviation is coded and visible.

### EPQ.4 — Cost truth & honest promises (D1/D2/D3/D4)
Structured cost model behind the existing cost figure: leather consumption table (m² per style×size + wastage %), labor (hours × configurable rate), overhead %; per-line cost breakdown visible to the Owner; **quote-vs-actual**: after an order ships, its actual consumption/cost (FP6 ledger data) appears beside the originating quote, and similar-quote recall prefers actuals over estimates; CTP-lite: promise date = base lead + f(open work orders) + leather procurement lead, shown with its terms ("3w base + 2w backlog"). Convert freezes the FULL config spec (options, measurements link, notes) as the production handoff doc, not just money lines. **Exit:** parity-guarded (cost model output = current figures for existing quotes); promise formula backtested against shipped orders' real lead times on the harness.

### EPQ.5 — Acceptance that stands up (Italy/EU compliance pass — research complete, all citations in the phase spec)
The research found one live compliance bug and several cheap-but-load-bearing gaps:
- **B2C gross-price display (the bug):** consumer quotes MUST headline the VAT-inclusive total (Cod. Consumo artt. 49/22; VAT-silent consumer prices are read as VAT-inclusive AGAINST the seller). Quote gains a customer-type-driven tax mode: B2C = gross-first PDF; IT-B2B = net + IVA 22% line; EU-B2B = "non imponibile art. 41" **gated on a VIES check** (SOAP `checkVatApprox`, stored `requestIdentifier` + timestamp as the canonical audit proof — a substantive condition for zero-rating since the 2020 Quick Fixes); extra-EU = art. 8 export. Natura codes + SDI routing fields (codice destinatario/PEC/CF) captured per party so downstream invoicing is mechanical. Domestic reverse charge deliberately absent (closed list — doesn't apply to apparel).
- **Deposit label enum `acconto | caparra_confirmatoria`** (silence legally means acconto; the label forks BOTH cancellation consequences — art. 1385 keep/double-return vs refundable — AND invoicing: acconto = immediate fattura di acconto at receipt, caparra = quietanza, VAT at delivery). Template clauses per label; B2C caparra carries the mandatory symmetric wording; default 30% (trade-modal), range 20-50%.
- **Acceptance evidence bundle** (CAD art. 20 probative criteria): token→verified-email binding, server timestamp, IP, user agent, SHA-256 of the exact PDF version shown, CGV version id, full send/open/accept event log — immutable with the QuoteVersion. Vessatory clauses stay OUT of the CGV entirely (Cass. 20945/2026: a click/flag cannot approve art. 1341(2) clauses — avoiding them beats building an OTP step). Optional "conferma d'ordine" PDF generated on acceptance for B2B brands.
- **B2C made-to-measure withdrawal disclosure:** fixed clause "diritto di recesso escluso ex art. 59 c.1 lett. c) D.Lgs. 206/2005" printed on bespoke B2C quotes (exemption is real — CJEU C-529/19 — but only if disclosed); per-template bespoke flag so a future standard-size item follows the normal 14-day regime instead.
- **Validity wording as a deliberate template choice** (bare "valido fino al" = revocable offer; irrevocable requires express commitment wording — art. 1329 c.c.).
- **Incoterm field on cross-border B2B** (default DAP; EXW warning citing the 2024 90-day/50%-penalty rule); EUR canonical, courtesy conversion display-only.
- **Retention:** 10-year immutable retention of quote versions + CGV versions + acceptance events (art. 2220 c.c.), hash-chained event log for tamper evidence, one privacy-notice paragraph + purge job (GDPR).
- **Deposit payment on the acceptance page (D-1):** built env-gated on Stripe keys, bank-transfer instructions as the always-on fallback; the acconto invoice trigger honors the label enum above.
**Exit:** an accepted quote yields a court-defensible evidence bundle; PDFs are tax-correct per customer type; the deposit's legal character is explicit everywhere it appears.

### EPQ.6 — The pipeline as a command center (A1/A5/D5)
Revision diff (v2 vs v3: lines/prices/terms before-after); clone-as-draft (any quote, any state); pipeline KPIs: aging since send, days-to-first-view, sent→decision turnaround, conversion by party kind — as grid columns + counters (the Analytics PAGE remains EPA's; quotes only surfaces per-quote numbers and exposes the aggregates for EPA to consume later — recorded in the program registry); saved pipeline views (existing SavedView substrate). **Exit:** the Owner can answer "which offers are rotting and why" from the pipeline alone.

## 6. Coordination (program registry compliance)

Consumes, never builds: notifications (exists), SavedView (exists), worker tick pattern (exists), FS3 comboboxes when they land (matrix editor works without them), FC quote-feed integration deferred to FC5 (system messages). Nothing here touches Inbox surfaces (EPI is claimed by another session — the EPQ.2 templates SEND via the existing thread APIs only). New substrate this page DEFINES for the house: the approval/floor-ack pattern + acceptance-evidence pattern (registered in ENTERPRISE-PROGRAM.md).

## 7. Owner decisions

| # | Decision | Recommendation |
|---|---|---|
| D-1 | Deposit payment on acceptance page (Stripe account, ~1.5%+€0.25/txn, payout setup) | **Yes, EPQ.5** — largest cycle-time lever; falls back to bank-transfer instructions if declined |
| D-2 | Follow-ups: auto-send vs Owner task queue | **Task queue** — auto-send risks tone; queue keeps control total (can flip later) |
| D-3 | Margin floor: keep speed-bump-with-persisted-ack vs hard block | **Speed bump + persistence** — you are the approver; the record is what was missing |
| D-4 | Deposit wording default: acconto vs caparra confirmatoria | Decide in EPQ.5 with the legal citations in front of you |
| D-5 | Already-lapsed SENT quotes when EPQ.1 ships: sweep them to EXPIRED or grandfather | **Sweep, with a one-time review list** |

Recommended build order: EPQ.1 → EPQ.2 → EPQ.3 → EPQ.5 → EPQ.4 → EPQ.6 (correctness first, silence-killing second, money discipline third; EPQ.4's cost model is the deepest change so it goes after the compliance pass locks the customer-facing surface).
