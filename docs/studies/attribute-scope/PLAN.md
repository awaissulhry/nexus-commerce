# Plan — Attribute scope: a small shared core, channel fields on their channel, driven by connected channels

**Status: 🟢 APPROVED by the Owner 2026-09-26.** D1 = A (placement label, values stay). D2 = build in the attributes session as step P3b; UI parts go to the product-sheet session.

## Context

- **Your worry is right.** The Shared view has 242 attributes. Only **54 are core** (facts any channel can use). **74 belong to one channel** (69 Amazon, 4 eBay, 1 Shopify). **114 are unused or duplicates.**
  Full list, one row per attribute: `/private/tmp/nexus-attribute-scope/docs/studies/attribute-scope/appendix-a-classification.md`.
- **Why:** one manual script on 2026-09-07 (`apps/api/scripts/complete-channel-mapping.mts`) turned every field of 31 cached Amazon/eBay schemas into a shared attribute. The "copy to another business" feature then spread the list. Motovento (eBay + Etsy only) now has 197 Amazon-shaped attributes.
- **The Shared view never asks which channels you connected.** Readiness also makes "no account" rows for every switched-on market.
- **Almost no data moves.** The shared value store is nearly empty in production (measured today).
- **Study:** `/private/tmp/nexus-attribute-scope/docs/studies/attribute-scope/README.md` (branch `study/attribute-scope`, not committed).
- **Goal:** a small core on Shared. Channel fields live on their channel. What you see follows the channels you **connected**. Every move is one click, with a preview, and can be undone. Nothing is deleted.

## The rules (the target)

1. **Placement is a label, not a data move.** Each attribute gets `placement` = `shared` or `channel` (plus which channels). The value stays where it is. The Amazon scope already reads the same key.
   The name is not "scope": `CustomAttribute.scope` already means "per variant".
2. **One "channel footprint" per business** = active, connected accounts (oauth or env) and their markets. An expired token still counts as connected, so columns never vanish. Readiness, sheet coordinates, "required by" marks and suggestions all read it.
3. **Core attributes link to concepts** (the attributes session's concept list, `semanticKey`). A concept knows its Amazon, eBay, Shopify and Etsy names. So links work with no manual rule, also after a copy.
4. **Channel fields come from the channel's own schema** (Amazon product type per market, eBay category per site, Shopify category, Etsy category). They need no shared row.
5. **Nothing is lost.** Archive instead of delete. Merge with a preview. A required attribute is never hidden. Every change is audited and can be undone.

## What the worst cases become

| Business | Shared | Channel scope | Readiness |
|---|---|---|---|
| Only eBay | Core only, with eBay badges | eBay aspects of the category | eBay only |
| Only Amazon | Core only, with Amazon badges | Amazon product-type fields (the 69 Amazon-only ones) | Amazon only |
| No channel | Core starter set | none | Shared only + "connect a channel" |
| Channel added later | Unchanged + suggestions ("eBay asks for Season — add to Shared?") | New scope appears | That channel's gaps appear |
| Channel removed | Attributes only it used go "dormant" (hidden, never deleted) | Hidden, values kept | Gone |

## Steps

Every step has these checks: `tsc`, tests on a database named `*test*`, a planted mistake that the test must catch, and two-business isolation tests where a table changes. **No push or deploy without your word** (a push migrates production). All schema changes add only; nothing is dropped.

| # | What | Session | Main files | Done when |
|---|---|---|---|---|
| S0 | **Baseline.** Read-only production measure (`BEGIN READ ONLY` … `ROLLBACK`): Shared columns per family, stored keys, readiness rows by state, connections. Test fixtures from the real `workspaceService.create`: F1 eBay-only, F2 Amazon-only, F3 none, F4 Motovento-shaped (real copy of the 242). | attributes | new `apps/api/scripts/attribute-scope-measure.mts`, `test-support/attribute-scope-fixtures.ts` | Tests pin **today's** behaviour on F1–F4. Each later step flips one. |
| S1 | **Channel footprint** helper + `GET /api/channel-footprint`. One rule, with a test that it matches the web scope bar. | attributes | new `apps/api/src/services/channel-footprint.service.ts` (reuses `listManagedConnections`, `connection-resolver.service.ts:396`; Amazon markets from `Marketplace.isParticipating`) | Unit table; isolation test between 2 businesses; same answer as `_studio/scopes.ts:128`. |
| S2 | **Readiness uses the footprint.** No more "no account" rows. Shared language rows stay (they hold catalogue sort keys). Connect or disconnect → background rebuild (the existing pending job). | attributes | `readiness-index.service.ts`, `scope-readiness.service.ts` | F1 has no Amazon rows; F3 has Shared rows only; Shared row count unchanged. **Tell the listings-readiness session** (its totals shrink). |
| S3 | **Schema + API.** Migration `…_attr_placement`: `CustomAttribute.placement` (default `shared`), `placementChannels`, `archivedAt`. A placement change also moves "required" to those channels. Hard delete → "archive instead" when values or links exist. Audit before/after. | attributes | `schema.prisma`, `packages/database/workspaces/*.json`, `attribute-dictionary.service.ts`, `attributes.routes.ts` | Drift / ownership / policy checks pass. **Publish parity:** the channel payloads on F4 are identical before and after a flip. |
| S4 | **Shared follows placement.** Shared shows `placement=shared` and not archived. Values of channel-placed or channel-only keys no longer leak back as "Additional saved attributes". Real old keys (for example `waterproofRating`) stay visible. A product with no family shows the business's core. Cache keys get the dictionary version and the footprint. | attributes (tell the product-sheet session) | `family-sheet-schema.ts`, `sheet-columns.service.ts` (`:1238-1254`, `:1334-1335`), `studio-columns.ts`, `products-sheet.routes.ts` | F2 leak gone; old key still shown; an edit shows at once (no 5-minute staleness). Column load is no slower than today (191 ms cold). |
| S5 | **Cleanup of the 242, reviewed.** A proposal file made from the study's table (codes and classes only, no private data). A screen shows it by group (Core / Amazon / eBay / Shopify / Duplicates / Not relevant). You approve group by group, or "approve the rest". Fingerprint, one transaction, undo. The 4 rows where the study and the concept list disagree (`ceCertification`, `collar_style`, `lining_description`, `theme`) are shown to you first. | attributes (API) + design-system screen | new `packages/shared/attribute-placement-proposal.ts`, new `pim/attribute-placement-correction.ts` (same pattern as `information-dictionary-correction.ts`), new `settings/pim/attributes/placement/` | A stale preview is refused; approving part of it works; undo restores exactly. F4 → core + what eBay uses. **Production apply only on your word, per business.** |
| S6 | **"Used by" badges + dormant.** Each Shared column says which connected channels use it and where it is required. Dormant = used by no connected channel → hidden by default (the existing `defaultVisible`). "Show hidden" goes in the existing Customise dialog. | attributes (API) + product-sheet (UI) | new `pim/attribute-usage.service.ts`; a new design-system channel badge (recorded in `.claude/DS-GAPS.md`, mirrored to `apps/factory`) | F1 shows only eBay badges; hidden columns can be shown again. |
| S7 | **Copy to another business keeps the decisions.** Placement and concept travel. Archived rows stay behind. A concept clash with the receiver's starter list is shown as a choice, never skipped silently. | attributes (agree with the assortment owner) | `assortment/copy-source.service.ts`, `copy-preview.service.ts`, `copy-run.service.ts` | Created + conflicts = offered; F4 through the real copy. |
| S8 | **Settings screens move to the design system.** Attributes list: concept, placement, used by, fill rate, families. Actions: Move to Shared / to channel, Archive / Restore, Required per channel (a channel picker, not typed text). | product-sheet or attributes UI | `settings/pim/attributes/AttributesClient.tsx`, `settings/pim/families/[id]/FamilyEditorClient.tsx` | No old `components/ui` imports; keyboard, light/dark, mobile checked. |
| S9 | **Merge** (fill the survivor where empty, archive the other, list its references; no rewrite of mappings in v1). **Suggestions** when a channel is connected or its rules change. **"Move eBay aspect to Shared"** = link only in v1; copy values only where all listings agree. | attributes | `schema-change-impact.service.ts` + new small services | Suggestions appear for F1 after its eBay category adds an aspect. |

Order: S0 → S1 → S2 give value early (no fake Amazon rows). S3 → S4 → S5 fix the Shared view. S6–S9 add comfort.

## Decisions (short)

- **D1 — Where channel-only attributes live.** I go with **A: a placement label; values stay where they are.** B (moving values into channel stores) would change more than 130 readers. I will not ask again unless you disagree.
- **D2 — Which session builds it.** ✅ You chose: **the attributes session** (`feat/attributes`, `/private/tmp/nexus-attributes`), as a new step "P3b — attribute scope". The product-sheet session builds the badges, the sheet menu and the Customise section. This study session stays read-only.

## After you approve, this session will only

1. Copy this plan into the study folder as `PLAN.md`.
2. Write a hand-off note for the attributes session (P3b) and the product-sheet session (S6/S8 UI parts), in the study folder (`HANDOFF.md`). I do not edit their worktrees.
3. Save a memory pointer.

This session changes no code, schema or product-sheet file.

## Verification (end to end)

- F1–F4 fixture tests: each step flips exactly the expected snapshot.
- Real Postgres, 2 businesses: B cannot read or change A's placement, archive or proposal.
- Publish parity on F4: the Amazon and eBay payloads are the same before and after every placement change.
- Browser check of the sheet (Shared + eBay + Amazon scopes) on a local copy for F1, F2 and F4.
- Read-only production measure before S5 and after each approved group.

## Gaps you should know

- One read-only production read (the full live attribute list) was **blocked** by the safety check. The table uses the 2026-09-10 snapshot (242; production has 241). S0 closes this gap: allow the read, or run it yourself.
- eBay required flags are confirmed for 177104 (jackets) only. Etsy and Shopify categories are not assigned in the stores yet.
