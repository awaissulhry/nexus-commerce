'use client'

import { VariantIdentity } from '../VariantIdentity'
import type { MenuItemDef } from '@/design-system/components'
import type { StudioRow } from '../../sheet/master/types'

/**
 * VP.4 — §4.3's column model, and the two cells this lane draws itself.
 *
 *   strip:    PRODUCT              │ EBAY · IT
 *   columns:  identity 380         │ Included 90 · <one per mapped axis, 150/130> · Listing (fill)
 *
 * §4.3 is explicit that there is NO shared-axes group on this scope: *"the identity secondary line
 * already carries the shared values"*. So the axis columns here are the CHANNEL's projected values,
 * and the two vocabularies never sit side by side pretending to be one.
 *
 * Three engine rules this file obeys rather than rediscovers:
 *  - the identity band is `IdentityBand`, the engine's, in the slot order master and the channel
 *    sheet both use (expand · role · picture · sku · secondary · trailing) — #710/#721;
 *  - `Included` and `Listing` are VP.5's `ProjectionCell`, the DS renderer, not a second one;
 *  - a cell's overlay is a normal flex child, never `position: absolute`: an absolutely positioned
 *    child of an AG cell ESCAPES the cell (hub ruling #12, programme-wide).
 *
 * 🔴 **The column model is built from the column SET, and reads its data through a HOST.** AG re-runs
 * the whole column model for every new `cellRendererParams` identity (GDS decision 12,
 * reference_ag_react_inline_options_rerun_column_model), and this surface's context changes on every
 * optimistic include/exclude — the pending set. So the params carry one stable `host` whose `get()`
 * is read AT PAINT TIME, the same discipline `CascadeCell`'s `refusedReasonFor` follows, and the
 * columns are rebuilt only when the mapped axes or the coordinate change.
 */
import { memo } from 'react'

import { SourceIndicator } from '@/design-system/components'
import {
  EmptyValue, ProjectionCell, SelectChevron,
  projectionMeta, selectEditor, textEditor, type ColDef, type ColGroupDef, type ICellRendererParams, type ProjectionFacts,
} from '@/design-system/grid'

import { planPin } from './pinValue'
import type { ProjectionPage, ProjectionValue } from './types'
import { projectionActionRow, projectionReadinessPill, type ProjectionRow } from './rows'

/** What the cells need from the surface, read at paint time. */
export interface ProjectionCellContext {
  page: ProjectionPage
  /** In-flight include/exclude, by child id. */
  pending: ReadonlySet<string>
  /** In-flight pin/reset, keyed `<childId>:<axisKey>` — one cell, not one row. */
  pinning: ReadonlySet<string>
  rowMenu(row: StudioRow): MenuItemDef[]
  onValueChange(childId: string, axisKey: string, value: string): void
  onIncludedChange(id: string, included: boolean): void
  /** One click pins the resolved value for this coordinate; one click resets it (layout doc §1). */
  onPinToggle(childId: string, axisKey: string): void
}

/** One stable object per mounted surface. Its identity never changes; what it returns does. */
export interface ProjectionCellHost {
  get(): ProjectionCellContext
}

/**
 * What the column model is keyed on. Change any of it and the columns are rebuilt; change anything
 * else — a row, a pending write, a version — and they are not.
 */
export function columnSignature(page: ProjectionPage | null): string {
  if (!page) return ''
  const axes = [...page.mapping].sort((a, b) => a.order - b.order).map(m => `${m.axisKey}>${m.target ?? ''}`)
  return JSON.stringify([page.coordinate, page.vocabulary.axisNoun, axes, page.axisColumns])
}

/* ── identity ─────────────────────────────────────────────────────────────────────────────── */

const IdentityCell = memo(function IdentityCell(p: ICellRendererParams<ProjectionRow> & { host: ProjectionCellHost }) {
  const row = p.data
  if (!row) return null
  const { page, rowMenu } = p.host.get()
  const source = row.child ?? row.parent
  if (!source) return null
  const isParent = row.kind === 'parent'
  const actionRow = projectionActionRow(row, page)
  const progress = projectionReadinessPill(source)
  return <VariantIdentity sku={source.sku} isParent={isParent} parentId={actionRow.parentId} childCount={page.children.length}
    image={source.image} inherited={row.child?.imageInherited} axes={(page.axes ?? []).map(axis => row.child?.sharedAxisValues?.[axis.key] ?? '—')}
    suspect={row.child?.axisValuesSuspect} pct={progress.pct}
    readiness={progress.state}
    completenessTip={progress.tip}
    menuItems={rowMenu(actionRow)} />
})

/* ── a mapped axis value — the sheet's CascadeCell vocabulary ─────────────────────────────── */

/**
 * §4.3: *"value + chevron + `SourceIndicator` (link glyph `--nds-text-3` = inherits the shared
 * value; pin glyph `--nds-text-link` + 7% primary tint `.nds-cell-is-pinned` = pinned for this
 * channel). Hover names the source; one click pins, one click resets (layout doc §1)."*
 *
 * 🔴 The pin ACTION is labelled before it is clicked, and that is not a softening of "one click".
 * `SourceIndicator` composes `label. description. actionLabel` into both the tooltip and the
 * accessible name, so the sentence an operator reads on hover is the sentence describing what the
 * single click will do. The sheet's `CascadeCell` deliberately routes its indicator to a details
 * panel instead ("inspecting a source never changes its value"); this surface has no details panel
 * and §4.3 asks for the layout-doc gesture, so the click acts — and says so first.
 *
 * 🔴 It is HELD, not inert, when the wire carries no write routing. Pinning is a channel write and
 * `commitChannelRow`'s own rule is that the target comes from the CELL, never from the client
 * (`useChannelSheet.ts`) — a client that re-derives it is how a channel edit lands on the master
 * record. So with no `write` on the value there is no action and the reason is in the tooltip,
 * never a control that looks live and does nothing.
 */
const ValueCell = memo(function ValueCell(
  p: ICellRendererParams<ProjectionRow> & { host: ProjectionCellHost; axisKey: string; axisLabel: string },
) {
  const row = p.data
  const { host, axisKey, axisLabel } = p
  if (!row) return null
  if (row.kind === 'parent') return <EmptyValue />
  const child = row.child
  if (!child) return null
  const cell: ProjectionValue | undefined = child.values[axisKey]
  if (!cell) return <EmptyValue />

  const ctx = host.get()
  const pinned = cell.source === 'pinned'
  const channel = ctx.page.coordinate.label
  /**
   * 🔴 `sharedAxisValues` is the family's axis TUPLE — which combination this variant is — and NOT
   * a value anything inherits. Measured on eBay·IT: the tuple reads `Nero` on all 20 children while
   * master's `color` is null on the same children. So the hover names the COMBINATION, and only a
   * cell that actually inherits says what it inherits. Saying "the shared value is Nero" beside a
   * master record that holds nothing was this cell's own first version, and it is the sentence that
   * would have talked an operator into emptying a live specific.
   */
  const combination = child.sharedAxisValues?.[axisKey] || null
  const label = pinned ? `Pinned for ${channel}` : 'Follows the shared value'
  const description = pinned
    ? `${axisLabel} is ${cell.value ?? 'empty'} on ${channel} only${combination ? `, on the ${combination} variant` : ''}.`
    : `${axisLabel} follows the shared product's value${cell.value ? ` — ${cell.value}` : ''}.`

  /* ONE rule answers the label, the accessible name and the write — `pinValue.planPin`. A tooltip
     that says "pin" beside a handler that resets is the disagreement a shared rule prevents. */
  const plan = planPin({ child, axisKey, cell, coordinate: ctx.page.coordinate, inheritedValue: cell.inheritedValue, inheritedValueUnknownReason: cell.inheritedValueUnknownReason })
  /* In flight: the action is HELD, not merely slow. Without this a second click sends a second
     write against a version the first one has already moved, and the operator sees a 409 they
     caused by clicking twice. */
  const inFlight = ctx.pinning.has(`${child.id}:${axisKey}`)
  const held = !child.included ? 'Include this variant to edit its channel values.' : plan.heldReason ?? (inFlight ? 'Saving this change…' : null)
  const actionLabel = held ? undefined : pinned ? plan.actionLabel : `Edit ${axisLabel} for ${child.sku} on ${channel}`

  return (
    <span className="nds-cascade nds-vp-value">
      <span className="nds-cascade-value">
        {cell.value ? String(cell.value) : <EmptyValue />}
      </span>
      {/* A SIBLING of the ellipsizing value box, never inside it — PES.2 #707 measured what an icon
          inside a truncating block does: it becomes inline content of a truncating block and falls
          to a second line. */}
      <SelectChevron />
      <SourceIndicator
        kind={pinned ? 'override' : 'master'}
        label={label}
        description={held ? `${description} ${held}` : description}
        actionLabel={actionLabel}
        onAction={actionLabel ? () => {
          if (pinned) ctx.onPinToggle(child.id, axisKey)
          else if (p.node.rowIndex !== null && p.column) p.api.startEditingCell({ rowIndex: p.node.rowIndex, colKey: p.column.getColId() })
        } : undefined}
      />
    </span>
  )
})

/* ── the model ────────────────────────────────────────────────────────────────────────────── */

/**
 * §4.3's widths, verbatim: identity 380 · Included 90 · a mapped axis 150 then 130 · Listing fill.
 *
 * 🔴 The axis columns are built from `mapping`, which is the same array the band and the dock read,
 * so a column and its chip cannot disagree about whether an axis is mapped. An UNMAPPED axis gets
 * no column — there is no channel value to show — and it is the `Mapping errors` chip and the dock
 * that say so, which is where an operator can act on it.
 */
export function projectionColumns(host: ProjectionCellHost, page: ProjectionPage): Array<ColDef<ProjectionRow> | ColGroupDef<ProjectionRow>> {
  const mapped = [...page.mapping].filter(m => m.target !== null).sort((a, b) => a.order - b.order)
  const coordinate = page.coordinate.label.toUpperCase()

  const axisColumns: ColDef<ProjectionRow>[] = mapped.map((m, i) => ({
    colId: `axis:${m.axisKey}`,
    headerName: m.target ?? m.axisLabel,
    headerTooltip: `The ${page.coordinate.channelLabel ?? page.coordinate.channel} ${page.vocabulary.axisNoun} ${m.target} — projected from the shared axis ${m.axisLabel}`,
    ...(page.axisColumns?.[m.axisKey]?.kind === 'select'
      ? selectEditor((page.axisColumns[m.axisKey].options ?? []).map(value => ({ value, label: page.axisColumns![m.axisKey].optionLabels?.[value] ?? value })))
      : textEditor()),
    editable: params => !!params.data?.child?.included && !!params.data.child.values[m.axisKey]?.write && !host.get().pinning.has(`${params.data?.child?.id}:${m.axisKey}`),
    valueSetter: params => {
      const child = params.data?.child
      if (child && params.newValue !== params.oldValue) host.get().onValueChange(child.id, m.axisKey, String(params.newValue ?? ''))
      return false
    },
    width: i === 0 ? 150 : 130,
    sortable: false,
    resizable: true,
    valueGetter: params => params.data?.child?.values[m.axisKey]?.value ?? null,
    cellRenderer: ValueCell,
    cellRendererParams: { host, axisKey: m.axisKey, axisLabel: m.axisLabel },
    /* The 7% primary tint, from the ENGINE's own class — never a local colour (§4.3). */
    cellClassRules: {
      'nds-cell-is-pinned': params => params.data?.child?.values[m.axisKey]?.source === 'pinned',
    },
  }))

  /** §4.3's `Included` — VP.5's `ProjectionCell` with the include flag as the cell VALUE. */
  const includedFacts = (params: ICellRendererParams): ProjectionFacts | null => {
    const row = params.data as ProjectionRow | undefined
    if (!row) return null
    if (row.kind === 'parent') {
      /* The parent IS the listing, not a variation in it — a tick here would offer to exclude the
         thing the other ticks are inclusions INTO. `state: null` with a note says so; `value` is
         null below, so there is no checkbox to hold. */
      return { state: null, note: '—' }
    }
    const child = row.child
    if (!child) return null
    const ctx = host.get()
    /**
     * 🔴 `state: null` — §4.3 gives this column a CHECKBOX, nothing else, in 90px. Passing the
     * listing state renders the dot and the §9 word too, and measured at 90px the word clipped to
     * `List…` beside the tick while the same word already stood, in full, in the `Listing` column
     * two columns over. One fact, one place.
     *
     * The hold that `state` would have supplied comes back explicitly: `not-set-up` is the only
     * state whose tick must refuse, and saying so here is clearer than relying on a table lookup
     * that also paints two things this column does not want.
     */
    return {
      state: null,
      heldReason: child.listing?.state === 'not-set-up'
        ? `This variant has no listing row on ${ctx.page.coordinate.label} yet, so it cannot be included.`
        : undefined,
      busy: ctx.pending.has(child.id),
      includedLabel: `${child.included ? 'Exclude' : 'Include'} ${child.sku} ${child.included ? 'from' : 'in'} this listing`,
    }
  }

  /** §4.3's `Listing` — the same renderer with NO checkbox (`value` null) and the state's word. */
  const listingFacts = (params: ICellRendererParams): ProjectionFacts | null => {
    const row = params.data as ProjectionRow | undefined
    if (!row) return null
    if (row.kind === 'parent' && row.parent) {
      const listings = row.parent.listings
      return {
        /* The parent's `listing` is shaped exactly like a child's — VP.2 nested it after one
           revision shipped it flat and took this page to the error boundary. Read it the same way
           in both places so a future divergence is one edit, not two. */
        state: row.parent.listing?.state ?? null,
        note: `${listings} ${listings === 1 ? 'listing' : 'listings'}`,
        detail: row.parent.listing?.externalId,
        title: row.parent.listing?.reason ?? undefined,
      }
    }
    const child = row.child
    if (!child) return null
    return { state: child.listing?.state ?? null, title: child.listing?.reason }
  }

  return [
    {
      headerName: 'PRODUCT',
      groupId: 'product',
      children: [
        {
          colId: '__identity',
          headerName: 'Product',
          width: 380,
          minWidth: 380,
          maxWidth: 380,
          pinned: 'left',
          sortable: false,
          resizable: false,
          suppressSizeToFit: true,
          valueGetter: params => params.data?.child?.sku ?? params.data?.parent?.sku ?? '',
          cellRenderer: IdentityCell,
          cellRendererParams: { host },
          /* §4.3 — an excluded row reads muted, and the identity opts OUT: it names which variant
             the row is, which is exactly what stays needed when the row is not in the listing. The
             quiet rule itself is the ENGINE's (`nds-row-is-quiet`), because grid chrome lives in the
             engine and a page stylesheet may not address `.ag-*` at all. */
          cellClass: 'nds-cell-identity nds-cell-full-strength',
        },
      ],
    },
    {
      headerName: coordinate,
      groupId: 'coordinate',
      children: [
        {
          colId: '__included',
          headerName: 'Included',
          headerTooltip: 'Whether this variant is part of the listing on this coordinate',
          width: 108,
          minWidth: 108,
          maxWidth: 108,
          sortable: false,
          resizable: false,
          suppressSizeToFit: true,
          valueGetter: params => params.data?.child?.included ?? null,
          cellRenderer: ProjectionCell,
          cellRendererParams: {
            facts: includedFacts,
            onToggle: (next: boolean, params: ICellRendererParams) => {
              const row = params.data as ProjectionRow | undefined
              if (row?.child) host.get().onIncludedChange(row.child.id, next)
            },
          },
          /* The tick is the one control an excluded row keeps — it is the only way back. */
          cellClass: 'nds-cell-full-strength',
        },
        ...axisColumns,
        {
          colId: '__listing',
          headerName: 'Listing',
          flex: 1,
          minWidth: 180,
          sortable: false,
          resizable: false,
          /* 🔴 `null`, deliberately: `ProjectionCell` reads the cell VALUE as the include flag, and
             null is how a column says "this one has no tick". §4.3 gives inclusion its own column. */
          valueGetter: () => null,
          /* The word still has to reach a CSV — the renderer is not the export path. */
          /* Optional-chained all the way down: a formatter runs on every row AG paints, including
             ones mid-update, and an exception here takes the page to the error boundary rather than
             blanking one cell. */
          valueFormatter: params => {
            const row = params.data as ProjectionRow | undefined
            const state = row?.child?.listing?.state ?? row?.parent?.listing?.state ?? null
            return state ? projectionMeta(state).label : ''
          },
          cellRenderer: ProjectionCell,
          cellRendererParams: { facts: listingFacts },
        },
      ],
    },
  ]
}
