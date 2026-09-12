'use client'

/**
 * PES.3 — the alias band: the group header row of a channel scope.
 *
 * Layout §1: "Rows = one collapsible group per listing alias (①②③…) … Per-row publish status +
 * readiness bar. `[+ Add listing alias]` row at group end."
 *
 * One band per listing alias. It carries the things that belong to the LISTING rather than to any
 * one variant: its name, its publish status, and how ready it is to be sent.
 *
 * ── Why it is 240px and not the width of the sheet (ruling #77, option c) ───────────────────────
 * The band renders in the pinned identity column, and a span cannot cross AG's pinned boundary —
 * measured: the left-pinned section is `ag-Grid-AutoColumn` (44px) + `__identity` (240px), and
 * identity is LAST in it, so `spanWithinSection` correctly returns 1. Unpinning would let the band
 * span the sheet but costs every variant row its always-visible SKU, which is what makes a
 * 102-column sheet navigable. So the band is DESIGNED for 240px rather than fighting for width.
 *
 * What that costs, stated rather than hidden: the ItemID and the variant count move to the hover.
 * That cuts against the Owner's visibility-over-minimalism preference, so the two things an operator
 * acts on — publish STATUS and READINESS — stay on screen at all times, and only the two reference
 * values move. The drawer's Listings pane (PES.4) carries the full record permanently.
 *
 * ── Why a band can say "no variations yet" ──────────────────────────────────────────────────────
 * 22 aliases on prod are childless shells — a real eBay ItemID with no variations and no stock
 * (measured 2026-09-01; 6 ACTIVE, 16 DRAFT, all at quantity 0). Drawing those as an empty group
 * would read as a loading bug. The band names the condition instead, because "this live listing has
 * nothing under it" is the single most useful fact this page can tell an operator about it.
 */
import { memo } from 'react'

import { CompletenessPill, ExpandButton, ExpandSlot, IdentityBand, ProvenanceMark, readinessMeta, useExpanded, type ICellRendererParams, type IRowNode } from '@/design-system/grid'
import { ProductRoleChip } from '../ProductRoleChip'
import type { MenuItemDef } from '@/design-system/components'

/* 🔴 The pill takes the STATE, not a tone and not a percentage (#43 → #724 → #727).
 *
 * The round trip is worth the four lines: adopting `CompletenessPill` briefly moved the readiness
 * colour onto the PERCENTAGE, which reverses #43 — measured here, an alias in state `errors` at 84%
 * painted neutral grey while the same control's `aria-label` said "Error". For about an hour this
 * lane's `aliasBarTone` looked like dead code and was ordered deleted with its cases, which would
 * have removed the rule's only guard in the hour the rule started being violated.
 *
 * The engine now owns the mapping (`readyPillTone`, moved there from `channel/rows.ts`) and the pill
 * reads it from the state this passes. So this file no longer imports a tone function at all — one
 * table, one mapping, and neither scope can answer the colour question differently. */

import { aliasMark } from './provenance'
import type { AliasSummary } from './rows'
import type { ChannelSheetRow, ReadinessState } from './types'


export interface AliasBandCellParams {
  summary: AliasSummary | undefined
  /** How many listing aliases the product has on this scope. The alias mark and label render ONLY
   *  when there is more than one — master's parent row has neither, and a single-alias product must
   *  read exactly as its master parent (Owner, 2026-09-05). */
  aliasCount: number
  /** The row's verbs — the same builder the variant rows use. The channel declares no parent-row
   *  verbs today (`channelActions`: HIDDEN off a variant), so the ⋯ does not render; if a verb is
   *  ever declared it appears here without touching this file. */
  menuItems?: MenuItemDef[]
}

/** Everything the 240px band cannot show, in one sentence the whole band carries as its title. */
function bandTitle(s: AliasSummary | undefined, label: string, status: string, state: ReadinessState | undefined, pct: number | null): string {
  const bits = [label, `Listing ${status.toLowerCase()}`]
  if (s?.alias.externalListingId) bits.push(`Listing ${s.alias.externalListingId}`)
  bits.push(s?.isUnadoptedShell
    ? 'No variations and no stock behind it yet'
    : `${s?.variantRows ?? 0} ${s?.variantRows === 1 ? 'variant' : 'variants'}`)
  bits.push(
    pct === null
      ? state
        ? `${readinessMeta(state, 'row').label} — this channel declares no required fields, so there is nothing to measure`
        : 'Readiness has not been measured for this listing'
      : state
        ? `${readinessMeta(state, 'row').label} — ${pct}% of required fields filled`
        : `${pct}% of required fields filled`,
  )
  if (s && s.rowsMissingRequired > 0) bits.push(`${s.rowsMissingRequired} rows missing required`)
  if (s && s.errors > 0) bits.push(`${s.errors} blocked`)
  return bits.join(' · ')
}

/**
 * The readiness bar. A bare percentage is a number an operator has to interpret; a bar beside it is
 * read at a glance, which is what a band is for.
 *
 * Both halves come from elsewhere on purpose (hub rulings #3 and #11): the PERCENT is the server's
 * (`AliasGroup.readiness.percent`, PES.5 §5) and the TONE is `readinessMeta(state, 'row')` — the
 * ratified two-arg form, row vocabulary, because this describes a LISTING. No local thresholds, so
 * two surfaces cannot disagree about what 71% looks like.
 */
/* 🔴 The local `ReadinessBar` is GONE (#721) — `CompletenessPill` from the engine replaces it, and
   it is a better control than the one it replaces: a bar AND a number, where this file drew a bar
   whose value could only be read by eye. Deleted rather than left beside it, because two readiness
   renderers in one repo is the drift the shared band exists to end. */


/**
 * The tree control for the identity band, on both row kinds.
 *
 * 🔴 `useExpanded` is the ENGINE's (`renderers/cells.tsx`, moved there at #719 so master and this
 * scope share one subscription to AG's `expandedChanged`). Reading `node.expanded` once is not
 * enough — AG mutates it and the cell does not necessarily re-render, which is the trap that hook
 * exists for. A leaf gets `ExpandSlot`, never nothing, or the SKUs in a family start at two
 * different x positions and the column reads ragged.
 */
export const BandExpander = memo(function BandExpander({ node }: { node: IRowNode<ChannelSheetRow> }) {
  const expanded = useExpanded(node)
  const isGroup = node.group === true || (node.allChildrenCount ?? 0) > 0
  return isGroup ? (
    <ExpandButton
      expanded={expanded}
      onToggle={() => node.setExpanded(!expanded)}
      labels={['Expand listing', 'Collapse listing']}
    />
  ) : (
    <ExpandSlot />
  )
})

export const AliasBandCell = memo(function AliasBandCell(
  p: ICellRendererParams<ChannelSheetRow> & AliasBandCellParams,
) {
  const row = p.data
  if (!row || row.rowKind !== 'parent') return null
  const s = p.summary
  const alias = s?.alias
  const label = alias?.label || row.name || row.sku
  const status = alias?.listingStatus ?? 'NOT LISTED'
  const pct = s?.percent ?? null
  /* 🔴 THE BAND IS MASTER'S PARENT ROW (Owner, 2026-09-05, from two screenshots: "the parent row is
     actually quite different in the Amazon and eBay scope than it is in the master scope"). Measured
     before this: master drew P · thumbnail · GALE-JACKET · 20% · ⋯ and this scope drew P · ★ ·
     "Primary" · "20 variants" · ACTIVE · 85% — five differences on one row, none a decision the
     Owner had made. Every prop below is what `MasterSheet.tsx`'s ProductCell passes for a parent.
     What the alias adds is shown only where it DISTINGUISHES: on a product with more than one
     listing alias, the mark (★ ①②③) and the alias label return, because two bands must be told
     apart and master never has two. The listing status left the band for the pill's tooltip — the
     scope tab already says "Amazon · Blocked 71%" and the publish control carries the verdict.
     The thumbnail is the family's picture, as it is on master's parent (Amazon images are per-ASIN,
     so the listing does own it); the earlier "claims a picture the listing does not own" reading
     is withdrawn for that reason. */
  const multi = p.aliasCount > 1
  const title = bandTitle(s, label, status, alias?.readiness?.state, pct)
  const sku = row.sku || label

  return (
    <IdentityBand
      expand={<BandExpander node={p.node} />}
      role={
        <>
          <ProductRoleChip product={row} />
          {multi && (
            <span className="nds-alias-mark" aria-label={alias?.position === 0 ? 'Primary listing' : `Listing alias ${row.aliasPosition}`}>
              {aliasMark(row.aliasPosition)}
            </span>
          )}
        </>
      }
      image={row.imageUrl}
      photoCount={row.imageInherited ? undefined : row.photoCount}
      noImage={!row.imageUrl}
      imageMark={
        row.imageInherited ? (
          <ProvenanceMark provenance="inherited" from="the family's picture — this listing has none of its own" />
        ) : null
      }
      sku={sku}
      secondary={multi ? label : null}
      secondaryTitle={multi ? title : undefined}
      menuItems={p.menuItems}
      menuLabel={`Actions for ${sku}`}
      trailing={
        /* #727 — the TONE is the caller's, from the listing's readiness STATE, never from the
           percentage (#43). The full sentence (label · listing status · variants · readiness ·
           blocked) is this pill's tooltip, so nothing the band used to print is out of reach. */
        <CompletenessPill pct={pct} state={alias?.readiness?.state} tip={title} />
      }
    />
  )
})
