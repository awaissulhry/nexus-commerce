# The Media library showed the same picture many times — research, plan, fix

The Owner, 2026-09-28: "In the image library on the left side of the page, I'm seeing multiple duplicates of the same
image. I do not want that to happen ever."

## Measured (production, read only, through the app)
GALE-JACKET's library held **197 photos but only 41 addresses**:
- **24** rows on the family root (our Cloudinary photos) — 15 of them in the photo plan.
- **173** rows on the 20 variants, all `m.media-amazon.com` (MAIN 30, LIFESTYLE 143). Each Amazon picture is stored
  once **per SKU**: one on all 20 SKUs, most on 10 (one colour's SKUs). **None** is used by the plan.
- The variants' MAIN rows have sort order 0, so the library opened with a wall of identical cards.
- Picture fingerprints (256-bit difference hash, computed in the browser) on the 41 addresses: a few are the same
  picture at two addresses (Amazon's copy and ours: "Level 2 protectors", "Available in colours", "100% waterproof"
  ×3). The 3 size charts look alike but are **languages of one chart** — not duplicates; they carry no language yet.

## Why
1. `loadLibrary` lists every `ProductImage` row of the root **and of every variant**, with no grouping.
2. The Amazon image backfill (`amazon-image-backfill.service.ts`, manual `POST /api/amazon/products/images/backfill`)
   writes each ASIN image on every child (its type guess is the only Amazon path that writes LIFESTYLE). Three more
   older paths write per-SKU copies or wipe-and-recreate them: listing reconciliation (Amazon enrichment), the Amazon
   catalog sync (`POST /listings/sync-amazon-catalog`), and "Apply to children" / bulk apply.
3. The upload duplicate check compared a file with **one product's** photos only, never the family's.

## Fix 1 — shipped in this PR (nothing is deleted)
- **One card per picture.** The Media read groups rows that share an address (Amazon size variants of one image are one
  address) or the same bytes (`contentHash`). The card is the row a plan points at, else the root's own row; the others
  are its `copies`. The root's own photos come first. Every copy's id still resolves, so no plan breaks.
  (`services/images/media-library-identity.ts`, used by the read and the switch seed.)
- **The "no repeats" rule counts copies as the same photo** — on the server (`POST /media/ops`) and in the page.
- **Upload checks the whole family** when it is on the plan (exact bytes → the existing photo is used; look-alike →
  the existing "use it or upload anyway" choice). Families not on the plan keep the per-product check: their per-SKU
  galleries are still separate stores.
- **The four older paths no longer write per-SKU copies for a family on the plan:** the Amazon image backfill skips
  those products (`productsOnPhotoPlan` in its report); reconciliation and the catalog sync leave their photos alone
  (their wipe would also have deleted rows the plan points at); Apply to children / bulk apply answer 409 with the
  standard "managed on the Media page" sentence.
- The photo window says when a picture is stored more than once ("…stored 3 more times (copies on other SKUs). The
  library shows it once.").

Measured on the local stack: TEST-JACKET with 3 SKUs × 2 copied pictures → **16 cards, not 22**; each copied picture
is the root's own card with 3 copies. Tests: identity rules 3; Media service 16 (real schema: one card per picture,
a copy refused in a set that holds it, family-wide upload scope, bulk apply refused); page model 8; upload route 9.

## Fix 2 — in progress (plan: [NEXT-PLAN-2026-09-28.md](NEXT-PLAN-2026-09-28.md) W4; record: PROGRESS.md § W4a)
- **Part 1 (W4a) built:** "Looks like …" and "Same photo?" (keep one; the other becomes its copy in every layer; Undo; Separate it); "Not the same".
- **Part 2 (W4b) built:** "Similar to … — language versions?", the versions choice in the same window, the photo window's language, versions and "Leave its versions"; every library answer in the page's Undo/Redo. **Part 3 (W4c):** fingerprints in production with `apps/api/src/scripts/backfill-image-facts.ts` (not the older script below), the Owner's word.

### The original plan for Fix 2
- **Same picture at two addresses** (Amazon's copy vs ours): mark it in the library ("Looks like …") with a
  **Same photo — keep one** action (the plan moves to the kept photo; the other becomes a copy of it, not deleted).
  Detection needs the fingerprints of the Amazon rows, which are empty today: the existing backfill script
  (`scripts/ie2-backfill-image-hashes.mjs`) must run once in production — the Owner's word, run on the Railway box.
- **Language versions:** the three size charts become one photo with IT/ES/FR versions — a "Language" choice on each
  library photo (the P4b library endpoint already stores it).
