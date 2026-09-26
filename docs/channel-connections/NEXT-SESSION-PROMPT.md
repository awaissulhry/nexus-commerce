# Paste-ready prompt — 2026-09-26

This replaces every earlier prompt (they are in git history). Status is never repeated here: it
lives in [COMPLETION-MATRIX](COMPLETION-MATRIX.md).

---

Continue the Nexus channel-connections programme. Scope: Amazon, eBay and Etsy. Shopify stays
connected; P8 (new channels) stays deferred.

**Start here.** Read `docs/channel-connections/COMPLETION-MATRIX.md` (releases, the switch table,
one state per requirement), then `2026-09-26-APPROACH-REVIEW.md` and `2026-09-26-STOCK-MODEL.md`.
Fetch `origin/main` and read the public `/api/health` build before you rely on any state.

**Where things stand (2026-09-26).** PR #4 (architecture), PR #14 (FBM stock hotfix), PR #15
(Package A) and PR #32 (release B+C) are merged and deployed. Every new switch is OFF. Nothing new
is enabled. No real eBay or Etsy order event has been processed end to end.

**Next work, in this order, each only on the Owner's yes:**

1. **Switch-on phase.** One switch at a time, each proven by a real event and a read-only query,
   following the local switch-on plan (kept out of the public repository). The first three: the
   Amazon app-secret expiry date and rotation queue; Amazon Orders 2026 (re-run the read-only
   probe first; the value is exactly `true`); Etsy orders (webhook, signing secret, T0, then both
   switches on API, worker and scheduler together — `ETSY-INGEST-ACTIVATION.md`).
2. **FBM stock repair** after the PR #14 hotfix is proven in production — option A, its own yes.
3. **Held or not built:** Amazon Finances A3/A4 (branch `fix/cx-amazon-finances`, after the A2 dry
   run on real data); eBay notifications end to end (handlers still `handlerMissing`; seller-token
   subscriptions); eBay privacy option A executor; Amazon Ads drift fix; Shopify order webhooks.

**Rules.**

- Work in your own worktree from `origin/main` (`git worktree add … origin/main`). Never edit, stash,
  stage from or run scripts in `/Users/awais/nexus-commerce`; other sessions own it. Always `cd`
  explicitly.
- Releases go by pull request. Push your branch (never to `main`, never force). The Owner decides
  each merge. A migrating release needs a recovery branch that carries its `packages/database` byte
  for byte; never revert a migration folder and never downgrade the database.
- Every new switch ships OFF. Turning any switch on, live vendor calls or probes, operator grants,
  KMS rewrap or key retirement, credential or environment changes, deletions,
  `prisma migrate resolve`, Finances cutover and P7 drops each need their own explicit yes.
- The repository is public: no production figures, hostnames, business names, SKUs, ids or buyer
  data in anything you commit. Evidence stays in local files.
- Quality: red first; real PostgreSQL for locks, races and row security; mutations killed by
  assertion for stock, money and security guards; independent review per slice; never weaken an
  assertion, timeout, ratchet or hook. UI uses the Nexus design system and is checked in a real
  browser (keyboard, 390/1280 widths, light and dark).
- Run API tests from `apps/api` and print the database host first (from the repo root the root
  `.env` points at production). Never overlap Prisma generation or builds with tests that share
  the client.
- Keep COMPLETION-MATRIX current, using exactly one state per requirement: implemented / deployed /
  enabled / production-verified. Report to the Owner in plain, short sentences.
