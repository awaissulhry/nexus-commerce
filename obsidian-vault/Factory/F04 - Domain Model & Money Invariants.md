# F04 - Domain Model & Money Invariants

> Canonical: `apps/factory/prisma/schema.prisma` (43+ models) + PLAYBOOK §7-8. Break one of these and the session failed.

Hub: [[F00 - Factory OS MOC]] · enforced program-wide via [[F06 - Enterprise Program (EP)]]

## Money invariants

- **Money = Int CENTS with `*Cents` suffix; percentages `*Pct` Float.** The field-strip (`strip-financials.ts`) deletes money keys **by name**, deny-by-default — a money field without the suffix is a security bug. Exporters/PDFs/email renderers must call `stripFinancials` explicitly.
- **Money truth lives in the pure folds** — `financials/rollup.ts`, `orders/money.ts`, the quote engine. Pages feed them, **never fork them**; the parity script guards every rewrite. (The FS1 team accepted a 10ms perf miss rather than fork a fold — that's the discipline.)
- **Net money model** — payments and balances are net; customer gross (net+IVA) exists only on the Fattura; VAT is display-only (no tax engine). The compliance seam is [[F18 - Financials (EPF)]] EPF.7 + [[F11 - Quotes (EPQ)]] EPQ.5.
- **Cost side is global (FD7)** — costs never vary by customer, so per-party margin is honest.
- In chat/system messages, money may only travel in structured `*Cents` fields (client-formatted post-strip) — free text is unstrippable ([[F21 - Chat & Order Spaces (FC)]] trap #1).

## Ledger & document invariants

- **Append-only stays append-only:** `MovementLedger` (IN/OUT/ADJUST/RESERVE/RELEASE) and `AuditLog` are never updated or deleted — corrections are compensating entries with mandatory reasons (FD8). Stock/committed/available are FOLDS, never stored.
- **Docstatus discipline:** sent quotes freeze (`QuoteVersion.sentSnapshot`); edits create v2; confirmed orders are never silently editable — amendments are audited revisions ([[F12 - Orders (EPO)]] EPO.5). State machines are forward-only with named backward edges, every transition audited + event-published.
- **Shared identity:** Order `ORD-214` → WorkOrders `ORD-214/1..n`; priority lives on the WO and drag-reprioritize reallocates reservations.
- **Deposit gating (FD13):** deposit quote % → WO created at confirmation but BLOCKED until a DEPOSIT payment lands; B2B-with-terms bypasses.
- **Certificates (FD14):** EN 17092 registry; QC blocks PACKING when the cert is missing/expired.

## RBAC recipe (every new route/page)

`export const permission` + every method wrapped in `guarded()` (coverage-checked) · registry in `auth/permissions.ts` (WORKER minimal by design — zero financial grains, no money pages in nav) · UI gates via `usePermission`/`<Can>` · financial endpoints map to `financials.*` grains · OWNER implicit-all. An OFFICE/ACCOUNTANT read-only role is a permission-list edit away (FD9 — pending as [[F18 - Financials (EPF)]] D-10).
