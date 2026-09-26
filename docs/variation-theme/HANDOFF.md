# VTR hand-off — 2026-09-26 late (read this first in a new session)

## Where we are

- Worktree `/private/tmp/nexus-variation-theme`, branch `feat/variation-theme-rebuild`, **rebased onto origin/main `417f61e3e`**.
- Research: `RESEARCH-1-shared.md`, `RESEARCH-2-channels.md`, `RESEARCH-3-categories.md` (file:line for every finding).
- `PLAN.md` is **APPROVED** by the Owner on 2026-09-26:
  - D1 (a): a live structure change is saved in Nexus, the listing is marked "publish needed", and the publish step does the channel work.
  - D2 (a): variation values become dictionary options (`AttributeOption`: code, label, synonyms, order).
  - New rule 7 (Owner): full control per channel. Every channel × market × account × listing alias can FOLLOW Shared or have its
    OWN setup (axes, names, order, value labels, inclusion, category). One-click "Reset to Shared". "Copy to markets" with a preview.
    We read "access" as "axes / setup". If it turns out to mean user permissions per channel, ask the Owner.
- **Step 0 (live bugs) is BUILT locally — NOT committed, NOT pushed.** The Owner has to say "commit" / "push" / "PR".
- Claim: top of `docs/pes-claims.md` in the main checkout (VTR row, "STEP 0 claimed").

## Step 0 — what changed (each bug: failing test first, then the fix)

| # | Bug | Fix | Test |
|---|---|---|---|
| 1 | eBay order tab "Restore inherited" left `_variationAxesMode='override'` → every eBay axis dropped | `ebay-presentation-order.service.ts` `restoreInheritedAxes`: an `override` becomes `inherit` and its names go, exactly as Information's Reset. No mode (legacy) = old behaviour | NEW `ebay-presentation-order.vitest.test.ts` (5) |
| 2 | eBay studio publish sent the Shared value, not the eBay cell the sheet shows | NEW `channelAxisValues()` in `stored-variation-projection.ts` (resolved channel cells → axis values, the sheet's rule); `studio-publication-ebay.ts` uses it | NEW `studio-publication-ebay-variations.vitest.test.ts` (7); parity stub updated |
| 3 | Publish counted a variant with NO listing row as included; the sheet does not | `studio-publication-plan.ts`: a VARIANT needs its own row here, not excluded. The family root and a single product keep their old answer | `studio-publication-plan.vitest.test.ts` (+2) |
| 4 | Live eBay re-publish skipped the variation checks | `studio-publication-ebay.ts`: the same checks for new and live | in the new eBay test |
| 5 | Amazon publish did not re-check a deprecated theme or a variant with no value | `variation-rules.service.ts`: cell field `valueGaps` + readiness kinds `theme-deprecated` (error on a draft, WARNING on a live listing) and `value-missing` (error). Amazon publish already reads these items, so `studio-publication-amazon.ts` is NOT touched (CHMAP M7 holds it). `sheet-rows.service.ts:53` kind union widened | `variation-rules.vitest.test.ts` (+6) |
| 6 | Shopify value order — runtime check | **Checked, not fixed — Owner 2026-09-26: fix in STEP 1 (value order gets one home):** no Shopify value order is stored anywhere. Shopify sends values in child-id order. GALE-JACKET: Shopify `3XL, 4XL, L, M, S, XL, XS, XXL, 5XL`; Nexus shows `XXS … 5XL` (borrowed from the eBay IT listing's `_axisValueOrder`) | probe only |

Checks run: api `tsc --noEmit` = 0 errors; 249 test files in `pim`, `shopify`, `channel-drift`, `ebay-presentation*`, `ebay-variation*`,
`ebay-family*`, `routes/product-studio*`: 2,656 pass, 2 files fail, both NOT ours:
`variation-quality` (asserts the DB is named `nexus_development` — environmental) and `variation-mapping-filter` (fails the same way on
the main checkout with `nexus_development`; the test picks a product by one row while another row of it collides).

## Measured on the private copy `nexus_vtr_test` (read-only probes, scratchpad `vtr/*.mts`)

- Rowless variants: 135 on 14 Amazon family destinations (94 of them on 11 LIVE families); 85 on 5 eBay drafts (no child rows at all).
  Before the fix, a publish of those live Amazon families would have CREATED those 94 variants on Amazon, while the sheet showed them
  unticked. Now they are not sent. The 5 eBay drafts now say "This family has no included variants to publish." until variants are ticked.
- eBay parity (sheet value vs builder value): 1 difference before (xavia-knee-slider-orange: sheet "Arancione", sent "Arancia"),
  0 after. 11 of 15 eBay family destinations use the eBay Inventory model and studio publish refuses them anyway.
- New readiness items on the sheet (46 family destinations): every new error lands on a family already blocked by a collision,
  except AIRMESH-JACKET Amazon DE/ES/FR (offer closed, row DRAFT, theme COLOR/SIZE deprecated) — publish sends nothing there anyway.
- `_axisValueLabels`: 0 rows on the copy (production NOT checked). eBay `FieldValueMap`: 0 rows.

| 7 | Shopify content read crashed on a never-saved family (`content-workspace.service.ts:103`, since `f212c2348`) | Owner 2026-09-26: fix in step 0. `digest(v ?? null)`; saved documents keep their digest | NEW `content-workspace-first-open.vitest.test.ts` (2); probe: GALE-JACKET · Shopify now opens |

## Findings for later steps (not fixed in step 0)

- **Amazon theme derivation picks a deprecated theme** when a current one covers the axes in another order: COAT DE/IT derive
  `COLOR/SIZE` (deprecated, tie-break `bare-form`) while `SIZE/COLOR` is current (`variation-theme-segments.ts:188-213`, the in-order
  match always beats a set match). Step 3 (channel side) should decide the rule; on a live listing a theme change = new parent.
- Amazon builder keeps its own copy of the channel-value loop (`studio-publication-amazon.ts:63-72`). When CHMAP M7 releases the file,
  switch it to `channelAxisValues()` (note: it matches `f.fieldKey === axis.target` too).
- `_axisValueLabels` (eBay value renames) are applied by the legacy push only; the sheet and studio publish ignore them → step 1 (labels
  get one home).
- The local dev DB (`nexus_development`) is 16 migrations behind main; a copy needs `prisma migrate deploy` (as `postgres`) before the
  sheet reads work (`CustomAttribute.semanticKey`).

## Next steps, in order

1. Owner 2026-09-26: "go with your recommendation" + **"fix each and everything and switch on the publishing for every channel and
   market"** → state + plan in `PUBLISH-EVERYWHERE.md` (two decisions open there: WooCommerce; who builds P3–P5). Step 0 still waits
   for his "commit / PR".
2. Before step 1, coordinate with the attributes session: P3b, P8, `resolve-batch.service.ts:338`, `AttributeOption` value codes.
3. Then steps 1–5 of `PLAN.md` §3. Each step is its own tested PR.

## Rules that still apply

- Build locally. No commit, push or PR without the Owner's word. Never force-push. No auto-merge.
- No production writes. Local tests use the private DB copy `nexus_vtr_test` (docker `nexus-development-postgres-20260908`, :55439)
  and a private Redis `nexus-vtr-redis-test` (:6399). Worktree `apps/api/.env` points at both (gitignored). Remove both when VTR ends.
- Never use the browser's saved logins. Use a throwaway local user, and delete it after use.
- Old servers :8093 (API) and :3003 (web) run from the PSIE worktree on `nexus_psie_test`. Stop them by PID. Never `pkill -f`.
- No artifacts. Summaries go in these `.md` files. Report to the Owner in simple, short English (ELI5 / STE).

## Coordination (Owner, 2026-09-26 ~20:45: "keep it all coordinated" — this VTR session coordinates)

| Lane | Session (ListAgents name) | Holds / does | Next checkpoint |
|---|---|---|---|
| VTR (this) | `nexus-commerce-12` | step 0 = PR #45 (open, no auto-merge); step 1 read-only (writer inventory, before-picture) | CI result on #45; the Owner's merge word; attributes answers Q1–Q6 |
| Publish everywhere (PE) | `nexus-commerce-de` — worktree `/private/tmp/nexus-publish-everywhere`, branch `feat/publish-everywhere` from 93215463f | claim row written; holds `docs/publish-everywhere/**` only; research + plan (P1, P3, P4, P5); agreed: no VTR-held file before #45 merges, no second value-order store | its plan; before any live send / switch / push it messages VTR |
| Attributes | `nexus-commerce-d7` (transcript e588a50c, started 16:29 local; found by process start time) | P3b S6 = PR #44 open; P8 reader switches; ANSWERED Q1–Q6 (accepted); builds the axis-attribute guard; owns the `resolve-batch:338` fix | code is stable (confirmed); guard = PR #46 (step 1 adds its axis-code field to `familyAxisLabels()`); :338 fix STARTED ~21:10 (measure first, it sends VTR the numbers before any change) |
| Sheet views | `nexus-commerce-60` | PRs #16 #17 #20 #21 #35 #42; #35 changes `completenessFor` in `sheet-rows.service.ts` (not VTR's :53) | none needed |

Messages sent 2026-09-26: coordination rules to `nexus-commerce-de` (acknowledged); Q1–Q6 to `nexus-commerce-60` (answered: it is SHEET-VIEWS) and then to `nexus-commerce-d7`. Replies arrive in the VTR session.

**Category field split (agreed ~21:20):** attributes lane (`nexus-commerce-d7`) = one channel → category-field map (AMAZON
`productType`, EBAY `categoryId`, ETSY `taxonomy_id`, SHOPIFY `category`) in `resolve-batch.service.ts:338` + `studio-sheet.service.ts:1341`,
after the Owner's word (it changes what Etsy/Shopify receive) — **Owner chose A (~21:30): fix both parts, send the mapped category**; building. VTR step 4 = the category source label + the Shopify category picker
(renderer with sheet-views `nexus-commerce-60`). Publish lane told to plan on the one map, no own fallback.
