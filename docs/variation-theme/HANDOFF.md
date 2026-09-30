# VTR hand-off — updated 2026-09-27 ~02:50 CEST (read this first in a new session)

## NOW — step 1b is DONE in production (2026-09-27 00:43–00:45 UTC)

**Done:** step 0 (#45) + 0b · step 1a (#56) · step 1b (#62, 069e697c8) · "Read live" route (PE #61/#64) + sheet UI (#67, merged by the
Owner 23:20 UTC) · **the step-1b backfill WRITE** (Owner's word; the Owner ran `vtr-2-write.sh` himself because the auto-mode classifier
blocks remote file writes for Claude): Xavia Racing 32 written / 0 failed / 0 skipped, second dry run = nothing planned, digest matched
`859e7e9d…`. Verified read-only afterwards: 32/32 roots carry `variationAxisCodes`; values under the codes, legacy axis copies gone;
28 new options (color +18 → 31, size +9 `v_44`…`v_60` → 20, fit_type +1); 0 outbound rows since the write. Left alone on purpose (not
axes): `variantAttributes` "Body Type" (AIRMESH-JACKET, 12 children) and "Style Name" (IT-MOSS-JACKET, 9). Motovento: nothing to do.
The tool file stays in `/app/docs/…` on the API box until the next deploy (a rerun plans nothing).

**Next VTR work:** step 1c (re-route the 50+ writers to the one writer, STEP1-PLAN.md), then steps 2–5 of PLAN.md §3. PE's next
session re-prepares its eBay Trading proof on GALE-JACKET fresh (versions moved tonight). Uncommitted here: HANDOFF.md, STEP1-PLAN.md edits.

**The dry run (production data, 2026-09-26 22:56 UTC, code 069e697c8):** Xavia Racing (`nexus_legacy_workspace`) 32 families planned,
635 value moves, 0 skipped, 0 conflicts, 28 new business options (size 44–60 → codes `v_44`…; fit_type Regular; 18 mixed colours such as
"Nero | Donna", "Bianco x Nero"), digest `859e7e9d016b55edaffcf7da07d172c1b910e8f655a26dd4f52516815bef9596`. Motovento: 0 families
(its GALE-JACKET copy has no axes, theme or values). The attributes lane plans no option change there (digest stays valid).
How it ran (the server copy was BLOCKED by the auto-mode classifier as a remote file write, before the Owner's word): production read
once in a READ ONLY transaction (a write attempt got 25006), then the merged `applyFamilyVariationsBackfill({ write: false })` planned
against a no-connection stand-in client. Scratchpad of the old session: `vtr/prod-dry-run.mts`, `fake-db*.mjs`, `out-prod-dry-run.json`.

**How the write was run (history):**
1. `/api/health` build must be current and no "Deploy API" run in progress (`gh run list --branch main`): a deploy restarts the box mid-write.
2. Copy `docs/variation-theme/tools/vtr-backfill.mts` from origin/main to `/app/docs/variation-theme/tools/` on `@nexus/api`
   (`railway ssh`; the image has no `docs/`); check its sha256 equals the local file from origin/main.
3. Dry run on the server (`cd /app && node --import tsx docs/variation-theme/tools/vtr-backfill.mts`): the digest must equal the one
   above (or show the Owner the new plan). Then `--write --digest <digest>`. The tool prints written/failed/skipped and a SECOND dry run
   (must list nothing). Each family is its own Serializable transaction; a failed family is rolled back and reported.
4. Tell the attributes lane the result (PE's session is closed; note it in `docs/pes-claims.md` for PE's next session).
The write sends nothing to channels (the service and its imports never reach the outbound queue); it bumps family listing versions and
emits PRODUCT_UPDATED (cache/SSE/readiness only).

## Where we are (history below; the block above is current)

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
| Publish everywhere (PE) | `nexus-commerce-de` — worktree `/private/tmp/nexus-publish-everywhere`, branch `feat/publish-everywhere` from 93215463f | claim row written; holds `docs/publish-everywhere/**` only; research + plan (P1, P3, P4, P5); agreed: no VTR-held file before #45 merges, no second value-order store | PLAN APPROVED by the Owner in its session (D1 a, D2 a); holds `pco7-amazon-proof.mts`, P4.0 `shopify/content-sync.service.ts` (synchronizeContent only), `shopify/listing-write.service.ts`, `outbound-sync.service.ts` (Shopify branch), P3.0 probe; preparing the Amazon proof (read-only); messages VTR before any send |
| Attributes | `nexus-commerce-d7`, later `nexus-commerce-f4` (transcript e588a50c, started 16:29 local; found by process start time) | P3b S6 = PR #44 open; P8 reader switches; ANSWERED Q1–Q6 (accepted); builds the axis-attribute guard; owns the `resolve-batch:338` fix | code is stable (confirmed); guard = PR #46 (step 1 adds its axis-code field to `familyAxisLabels()`); :338 fix STARTED ~21:10 (measure first, it sends VTR the numbers before any change) |
| Sheet views | `nexus-commerce-60` | PRs #16 #17 #20 #21 #35 #42; #35 changes `completenessFor` in `sheet-rows.service.ts` (not VTR's :53) | none needed |

Messages sent 2026-09-26: coordination rules to `nexus-commerce-de` (acknowledged); Q1–Q6 to `nexus-commerce-60` (answered: it is SHEET-VIEWS) and then to `nexus-commerce-d7`. Replies arrive in the VTR session.

**Category field split (agreed ~21:20):** attributes lane (`nexus-commerce-d7`) = one channel → category-field map (AMAZON
`productType`, EBAY `categoryId`, ETSY `taxonomy_id`, SHOPIFY `category`) in `resolve-batch.service.ts:338` + `studio-sheet.service.ts:1341`,
after the Owner's word (it changes what Etsy/Shopify receive) — **Owner chose A (~21:30): fix both parts, send the mapped category**; building. VTR step 4 = the category source label + the Shopify category picker
(renderer with sheet-views `nexus-commerce-60`). Publish lane told to plan on the one map, no own fallback.

**~23:00:** the category map landed as attributes PR #48 (`channelCategoryField()` in `pim/mapping/category-mapping.service.ts`; auto-merge on). VTR step 4 uses it for the source label; publish lane told. The Owner approved removing the old `output/` run folders, but VTR did NOT delete them: `output/shopify-impact-2026-09-08/` is the built Shopify theme the `integrations/shopify/impact` tools write and read, and `output/shopify-family-migration-2026-09-09/` is the evidence the 09-09 audit doc links to.

**~23:20:** PR #45 merged (074c1cf54). Owner picked (a) in the PE session: proof/probe tools run ON the production server (railway ssh) after merge + deploy; no decrypt key on a laptop (channel logins are KMS-sealed since ~06:20 UTC). PE: look-only ssh check, then a small PR (server mode for the proof tools).

**~20:45 UTC:** full deploy 98d6b4ce — API live 20:19, worker 20:26, scheduler building. PE: PR #58 (proof-tool workspace fix + P3.0
census record; VTR checked: no channel ids, only `nexus_legacy_workspace`). P3.0 census eBay IT (production, read only): 14 live items,
7 Inventory + 6 Trading agree with the `__offerIds` marker, 0 mismatches (step 0b's concern did not bite); GALE-JACKET main item: 1 of
20 SKUs has no eBay offer (MIXED). Amazon one-listing proof PREPARED on the worker (expires 22:32 UTC) — the Owner decides in the PE session.

**~20:55 UTC:** step 0 is LIVE on all three services (build 98d6b4ce: API 20:19, worker 20:26, scheduler 20:33; scheduler jobs run,
0 errors). PR #56 (step 1a) — every check green; waiting for the Owner's merge word.

**~21:40 UTC — order of the production steps (agreed):** (1) the deploy that carries #56 + #59 goes live; (2) the attributes lane
runs #59 on both businesses (colour 13 + size 11 options each) and messages VTR the counts; (3) PR #62 merges (Owner's word) and
deploys; (4) VTR runs `vtr-backfill.mts` DRY RUN on the server per business and shows the Owner the plan + digest; (5) write on his
word; (6) second dry run = nothing planned.

