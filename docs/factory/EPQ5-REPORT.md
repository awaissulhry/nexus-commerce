# EPQ.5 — Gate report: acceptance that stands up (Italy/EU compliance)

Built to `EPQ-PROPOSAL.md` §5 EPQ.5 (the legal research with citations IS the binding spec) by a worktree agent (merged into `5c09650ab`; conflicts with FS4 on contacts/convert/quotes routes resolved keeping both integrity guards and compliance logic). Migration `epq5_compliance` applied live + harness via `migrate deploy`; runtime restarted.

## Plain English
The quote flow is now legally correct for Italy/EU. The one real bug is fixed: consumer (B2C) quotes now headline the VAT-inclusive total, as Italian consumer law requires — a VAT-silent consumer price was legally read against us. Business quotes are unchanged except for an explicit IVA line. EU business customers get zero-rating only when their VAT number is verified against VIES (with the proof stored); without it, sending is blocked. Deposits now carry their correct legal character (acconto vs caparra confirmatoria — they differ on what happens if the order is cancelled, and on invoicing). Accepting a quote now captures a court-defensible evidence bundle (typed name, document hash, timestamp, the view trail). Made-to-measure B2C quotes print the mandatory "no right of withdrawal" clause. Deposit-on-acceptance via Stripe is built and dark until you add keys; bank-transfer instructions are the always-on fallback.

## Shipped
Party tax modes + SDI routing fields; Quote taxMode/naturaCode/depositKind/validityWording snapshots · per-mode PDF + public-page rendering (B2C gross-first — the fix; B2B net+IVA; EU_B2B art.41 VIES-gated; extra-EU art.8) · VIES check route (SOAP, stores requestIdentifier+timestamp; hard 422 on EU_B2B send without valid proof) · deposit legal enum with correct per-kind wording + B2C symmetric caparra clause · acceptance evidence bundle on QuoteVersion (typed-name now required, PDF sha256, CGV version, ipHash/UA, view-event trail) · made-to-measure no-withdrawal clause (ProductTemplate.bespoke, default true) · CGV via Legal gear (empty-safe) · validity wording toggle · Stripe deposit-on-accept env-gated + webhook (idempotent; promotes a pre-conversion deposit to a Payment at convert — the one place it touches order money, via the shared idempotency key) · 10-year retention privacy note.

## ⚠ Three Owner decisions (flagged, defaults shipped)
- **D-4 deposit default = ACCONTO** (schema default; "silence legally means acconto"). Confirm, or switch specific quotes to CAPARRA_CONFIRMATORIA in the rail.
- **CGV text is empty** — set it via Quotes → Legal gear; every surface renders empty-safe until you do.
- **Stripe + VIES need env keys** (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `FACTORY_VAT_NUMBER`) — all dark without them; bank-transfer fallback always shows. Names in `.env.example`, no values.

## Deviations (stated, not hidden)
- **B2C PDFs CHANGE — this is the bug fix**, not a regression. IT_B2B figures are byte-identical (parity asserted); legacy frozen QuoteVersions with no tax block render exactly as before.
- Public accept now requires a typed name (422 without) — old accept links still resolve, the name step appears before submit.
- `guard.ts` gained a narrowly-scoped `csrf:"skip"` for the signature-verified Stripe webhook ONLY.
- Merge resolution: EPQ.5's Stripe-deposit promotion at convert runs as a post-commit side effect inside FS4's new convert transaction structure (matches FS4's "side effects outside the txn" doctrine).

## Verified
524 tests in-worktree (36 new) → 568 on main post-merge · rbac 141 · query-bounds 143 · no-touch · ds-parity 97/97 · per-mode PDF render smoke · agent's live :3199 e2e (accept 422→200 with name; deposit block = 30% of gross; evidence bundle: name/ipHash/UA/pdf-hash/view-trail verified; Stripe dark → 404). Your remaining live steps: set the CGV text, and (if wanted) add Stripe/VIES keys — then a real B2C send to see the gross PDF, and an EU_B2B VIES check.
