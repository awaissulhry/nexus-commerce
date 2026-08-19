# MAP.6 — the flat-file edit list, for the operator's decision

**Status:** ✅ **(1) APPROVED AND SHIPPED 2026-08-19.** (2) still not proposed.
**Date:** 2026-08-19
**Why this document exists:** decision 3 (2026-08-19) was that the flat file is decided *at* MAP.6,
not up front, and that the edit list comes back before anything is opened. This is that list.

`apps/api/src/routes/ebay-flat-file.routes.ts` is a hard no-touch zone
(`feedback_flat_file_untouchable`). It holds the **last 12** ambient connection lookups in the
codebase — the MAP.3 ratchet baseline is 12 precisely because of them, and drops to 0 the day this
lands.

---

## What each of the 12 would become

All twelve are the same shape today:

```ts
const conn = await prisma.channelConnection.findFirst({
  where: { channelType: 'EBAY', isActive: true },
})
```

| Line | What is in scope there | Becomes |
|---|---|---|
| 1298 | `itemId`, `sku` | **DERIVED** — `tryResolveConnection({ itemId })` |
| 2942 | `itemId`, `marketplace` | **DERIVED** — `{ itemId, marketplace }` |
| 3009 | `itemId`, `marketplace` | **DERIVED** — `{ itemId, marketplace }` |
| 3068 | `itemId`, `marketplace` | **DERIVED** — `{ itemId, marketplace }` |
| 3146 | `itemId`, `marketplace` | **DERIVED** — `{ itemId, marketplace }` |
| 784 | relink token flow | **DECLARED** — `{ channel: 'EBAY', primary: true }` |
| 1523 | — | **DECLARED** |
| 3181 | `parentProductId`, `marketplace` | **DECLARED** (a product is not an account; the family may not be published yet) |
| 3281 | republish mode | **DECLARED** |
| 3431 | — | **DECLARED** |
| 3551 | `marketplace` | **DECLARED** |
| 3594 | `marketplace` | **DECLARED** |

**Five of the twelve are genuinely derivable** — they already hold the eBay ItemID whose listing they
are editing, so they become correct for two accounts rather than merely explicit. The other seven
state the primary on purpose, which is what every other converted route in the codebase now does.

## The size of it

- **12 statements changed**, each 3–5 lines → 1–2 lines, plus one import.
- **No behaviour change with one account**: every form returns the same single row today. That is the
  property that made the other 48 conversions verifiable on prod before a second account existed.
- **No change to the flat file's grammar, columns, import/export, or push semantics.** This is the
  connection lookup only.

## What is NOT in this list, and would be a separate decision

The plan's MAP.6 also describes making the flat file **account-scoped** — `?account=` honoured, rows
and push filtered by account, an Account column in import/export, a push preflight that refuses when
the file's account and the selected account disagree, and the cross-account duplicate-listing guard.
That is a much larger change to `EbayFlatFileClient.tsx` (4,717 lines) and the route file's read and
write paths, and it is **not** proposed here.

**Two separable asks, then:**

1. **The 12 lookups** — mechanical, invisible on one account, closes the burn-down to zero. Low risk.
2. **Account-scoping the flat file** — the real MAP.6. Large, and worth its own review.

Approving (1) does not commit you to (2).

---

## Outcome of (1) — shipped 2026-08-19

12 statements converted, 5 DERIVED and 7 DECLARED, exactly as tabled above. The diff is
**60 insertions / 46 deletions** in a 3,871-line file, most of it the explanatory comments.
Nothing else in the flat file was touched: not the grammar, not the columns, not import/export, not
push semantics.

**One thing the table above got wrong, found by reading the code rather than trusting the plan.**
A strictly-derived scope would have *broken* `reconcile-item`, `verify-item`, `convert-axes-italian`
and `relabel-item`. Those routes exist partly to CREATE the `SharedListingMembership` rows that
attribution is derived from — so on an item that has none yet, deriving strictly returns nothing and
the route would 503 on exactly the adoption case it is for. Each derived site therefore falls back to
the channel's primary:

```ts
const connection =
  (await tryResolveConnection({ itemId, marketplace })) ??
  (await tryResolveConnection({ channel: 'EBAY', primary: true }))
```

**Verified invisible.** For every distinct `(itemId, marketplace)` pair on prod — all 31 — the derived
path and today's behaviour resolve to the **same** connection; 0 differ, and 0 needed the fallback. An
unknown ItemID derives to nothing and falls back correctly, which is the adoption case working.

**The MAP.3 burn-down is closed: 60 → 0.** The ratchet baseline is now 0, so any new ambient lookup
anywhere in the codebase is a regression that fails the push, not a backlog item.

## Why (1) is worth doing even if (2) never happens

Until those 12 are converted, `ebay-flat-file.routes.ts` is the only file left that can silently pick
an account. The moment a second eBay account exists, twelve of the operator's most-used write paths
resolve it with `findFirst … isActive: true` — the exact coin flip the whole programme removed
everywhere else. The ratchet cannot protect a file it is not allowed to change.
