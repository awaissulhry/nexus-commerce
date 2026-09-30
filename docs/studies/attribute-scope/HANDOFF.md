# Hand-off — attribute scope (P3b)

Written 2026-09-26 by the attribute-scope study session. The Owner approved `PLAN.md` (this folder) and chose the
**attributes session** to build it. This study session edits no code, schema or product-sheet file. It did not touch your
worktree.

Read first: `README.md` (the study), `PLAN.md` (the approved plan), `appendix-a-classification.md` / `classification.tsv`
(all 242 attributes, classified).

## To the attributes session (`feat/attributes`, `/private/tmp/nexus-attributes`)

Add a step **P3b — attribute scope** to `docs/attributes/PLAN.md`. It covers plan steps S0–S5, S7 and S9, and the API half of
S6. Fit it after your P3 concept work, because it builds on `semanticKey` and the concept list.

Facts from the study that touch your uncommitted work:

1. **Starter seeding attaches no family** (`attribute-concepts-rows.ts:38-52`, `workspace.service.ts:153-156`). The studio
   Shared scope is always family mode (`studio-sheet.service.ts:1005-1023`, `sheet-columns.service.ts:1329`), so the
   starter attributes do not reach Shared. Plan S4: a product with no family shows the business's core.
2. **The saved-bag leak** (`sheet-columns.service.ts:1334-1335`): any bag key that is not a registry or family field
   comes back as "Additional saved attributes". Taking an attribute off Shared, or an Amazon-scope edit in an Amazon-only
   business (`channel-specs/amazon.ts:122-129`), puts its values there. Plan S4 filters channel-placed, archived and
   channel-only keys, and keeps real old keys (for example `waterproofRating`). The same filter is needed in
   `bulk-edit.service.ts`, `sheet-rows.service.ts` and `mapping/formula-reference-values.ts`, but **not** in the export
   (`catalog-transfer-plan.ts`).
3. **`CustomAttribute.scope` already means per-variant.** The new field is `placement` (+ `placementChannels`, `archivedAt`).
4. **4 rows where the study and your concept list disagree:** `ceCertification` (study: duplicate; concepts: adopted by
   `certification`), `collar_style` (duplicate; adopted by `neckline`), `lining_description` (channel-specific; adopted
   by `lining`), `theme` (channel-specific; a concept). The Owner decides these in the S5 review screen.
5. **Assortment copy** (`copy-run.service.ts:182-189`) copies neither `semanticKey` nor the new fields. With a starter
   list in the receiver, `createMany({ skipDuplicates })` would skip a clashing concept **silently**, together with its family
   links. Plan S7: show a `concept_clash` choice in the copy preview.
6. **Readiness writes "No active account" rows** for every switched-on market (`readiness-index.service.ts:28-92`).
   Plan S2 uses one channel footprint (active + oauth/env; an expired token still counts). Keep the Shared rows for each language
   (they hold catalogue sort keys). **Tell the listings-readiness session**, because its totals shrink.
7. **Cache keys hold no dictionary version** today (3 server caches + browser `max-age=300`). A dictionary edit is up to
   5 minutes stale. Plan S4 adds the dictionary version and the footprint to the keys.
8. **Production:** a read-only full dictionary read was refused by the study session's safety check. S0's measure script
   needs the Owner's permission or the Owner's run. Production applies (S5) need the Owner's word, per business.

## To the product-sheet session (`feature/product-sheet-views-p2`)

UI parts, after the attributes API for each is ready:

- **S6:** "used by" channel badges on Shared column headers, and a "Show hidden (dormant)" section in the existing
  Customise dialog (`design-system/patterns/PreferencesModal.tsx`). Dormant columns come with `defaultVisible=false`
  (the field already exists on the column contract).
- **The design system has no channel badge.** At least 7 local copies exist (for example `MappingCanvasClient.tsx:92`,
  `MatrixClient.tsx:1383`). Add one to `apps/web/src/design-system`, mirror it to `apps/factory/src/design-system`, and
  record it in `.claude/DS-GAPS.md`.
- **No column-header menu component** exists. The AG header menu is set in `design-system/grid/NexusGrid.tsx:336-346`
  (only `columnDialog`). Column actions (Move to channel, Archive) need a design-system extension. Watch the
  `{...agProps}` spread after `getMainMenuItems` (`:419` vs `:429`).
- **S8:** move `settings/pim/attributes/AttributesClient.tsx` and `settings/pim/families/[id]/FamilyEditorClient.tsx` off
  the old `components/ui` kit. The family editor's channels become a picker driven by the connected accounts (its own
  comment at `:15-18` asks for this).
