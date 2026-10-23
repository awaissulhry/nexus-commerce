'use client'

/**
 * Listing readiness — the grid's columns and cells, on the design system's cell library.
 *
 *   Product    the tree column: the DS identity cell (expander · photo · name → studio · SKU · "N variations"), drawn
 *              the way the Products page draws it (`next/columns.tsx` `ProductCell`, `next/ProductTreeCell.tsx`).
 *   Markets    one chip per destination — a DS `Pill` that is a real button; its tone and word are `readinessMeta`.
 *   Next step  the most urgent problem, a link to the exact field in the studio, and where it is.
 *   Checked    how old the check is; "Checking…" while Nexus rebuilds it.
 *   Actions    Fix (the Fix window) · Edit (the studio) — the DS `actionsColumn`.
 *
 * Cells read the page through AG's `context` (`ReadinessGridContext`): the destination labels, the Fix window and the
 * family page link. Every verdict, count and order is the API's.
 */
import { Fragment } from 'react'
import { ExternalLink } from 'lucide-react'
import type { ReadinessDestination } from '@nexus/shared/listing-readiness'

import Link from '@/lib/workspaces/Link'
import { browserWorkspaceId, workspaceHref } from '@/lib/workspaces/paths'
import { Button, Pill, Spinner, Tag } from '@/design-system/primitives'
import {
  ExpandButton,
  ExpandSlot,
  FamilyFooterFrame,
  IdentityCell,
  SkuTag,
  actionsColumn,
  readinessMeta,
  useExpanded,
  useGridDensity,
  type ColDef,
  type ICellRendererParams,
} from '@/design-system/grid'

import styles from './readiness.module.css'
import { chipAriaLabel, chipLines, chipText, fixDestination, fixHeldReason, nextStepPlace, orderedChips, plural, type PlacedChip } from './marketChips'
import { MARKETS_FIXED_WIDTH } from './marketsWidth'
import { absoluteTime, relativeTime } from './relativeTime'
import { canExpand, isFamilyRow, isMemberRow, isReadinessFooter, type ReadinessDataRow, type ReadinessGridRow } from './readinessRows'

/** What the cells ask of the page. One stable object (AG `context`); its functions read the page's current state. */
export interface ReadinessGridContext {
  /** The destinations of the latest answer, in chip order. */
  destinations: () => readonly ReadinessDestination[]
  destinationOf: (key: string) => ReadinessDestination
  /** Open the Fix window for this row on this destination. */
  openFix: (row: ReadinessDataRow, destinationKey: string) => void
  /** The bare address of one family's page (`?parent=`), with the current filters. */
  familyHref: (rootId: string) => string
  /** A family's own page: its members are flat, nothing folds open. */
  flat: () => boolean
  now: () => number
}

type CellParams = ICellRendererParams<ReadinessGridRow>
const contextOf = (p: CellParams) => p.context as ReadinessGridContext
const dataOf = (p: CellParams): ReadinessDataRow | null => (p.data && !isReadinessFooter(p.data) ? p.data : null)

/** Inside the current business (`/w/<id>/…`): the DS cells link with `next/link`, which drops the prefix. */
const inBusiness = (href: string) => workspaceHref(browserWorkspaceId(), href)

/* ── Product (the tree column) ──────────────────────────────────────────────────────────────────────────────────── */

export function ReadinessTreeCell(p: CellParams) {
  // Before any early return: the order of hooks is the same on every render.
  const expanded = useExpanded(p.node)
  const data = dataOf(p)
  if (!data) return null
  const ctx = contextOf(p)
  const expandable = !ctx.flat() && canExpand(data)
  const variants = isFamilyRow(data) ? data.variantCount : 0
  const name = data.name || data.sku
  return (
    <IdentityCell
      leading={expandable ? (
        <ExpandButton expanded={expanded} onToggle={() => p.node.setExpanded(!expanded)} labels={['Expand variations', 'Collapse variations']} />
      ) : (
        <ExpandSlot />
      )}
      image={data.imageUrl}
      photoCount={data.photoCount}
      title={name}
      titleAttr={name}
      href={inBusiness(data.editorHref)}
      openPill
      sub={
        <>
          <SkuTag>{data.sku}</SkuTag>
          {isMemberRow(data) && data.isParentListing && <Tag title="The parent product’s own listing">Parent listing</Tag>}
          {/* The count is the way to the family's own page, in a new tab so the place in this list is kept. */}
          {variants > 0 && (
            <Link
              className={styles.varCount}
              href={ctx.familyHref(data.id)}
              target="_blank"
              rel="noopener noreferrer"
              title="Open this family as its own page (new tab)"
              onClick={(e) => e.stopPropagation()}
            >
              {plural(variants, 'variation')} <ExternalLink size={10} aria-hidden />
            </Link>
          )}
        </>
      }
    />
  )
}

/* ── Markets ────────────────────────────────────────────────────────────────────────────────────────────────────── */

export function MarketChipsCell(p: CellParams) {
  const data = dataOf(p)
  if (!data) return null
  const ctx = contextOf(p)
  const chips = orderedChips(data.chips, ctx.destinations())
  if (chips.length === 0) return <span className={styles.none}>No listings</span>
  const pill = ({ chip, label, text }: PlacedChip) => {
    const sentence = chipAriaLabel(chip, label)
    const tone = readinessMeta(chip.state, 'scope').tone
    const open = () => ctx.openFix(data, chip.destinationKey)
    // A chip waiting for its rebuild says so with the DS spinner in place of its status dot.
    return chip.pending ? (
      <Pill key={chip.destinationKey} tone={tone} icon={<Spinner size={9} />} onClick={open} aria-label={sentence} title={sentence}>
        {text}
      </Pill>
    ) : (
      <Pill key={chip.destinationKey} tone={tone} dot onClick={open} aria-label={sentence} title={sentence}>
        {text}
      </Pill>
    )
  }
  // One line per store ("Amazon", "eBay · motovento") with its markets; Shared and the market-less stores first.
  return (
    <div className={styles.markets} role="group" aria-label={`Markets for ${data.sku}`}>
      {chipLines(chips, ctx.destinationOf).map((line) =>
        line.label === null ? (
          <div key={line.key} className={styles.marketLine}>{line.items.map(pill)}</div>
        ) : (
          <Fragment key={line.key}>
            {/* The chips' own sentences name the store; this is for the eye. */}
            <span className={styles.marketStore} aria-hidden>{line.label}</span>
            <div className={styles.marketChips}>{line.items.map(pill)}</div>
          </Fragment>
        ),
      )}
    </div>
  )
}

/* ── Next step ──────────────────────────────────────────────────────────────────────────────────────────────────── */

export function NextStepCell(p: CellParams) {
  const density = useGridDensity()
  const data = dataOf(p)
  if (!data) return null
  const step = data.nextStep
  if (!step) return <span className={styles.none}>{data.state === 'ready' ? 'Nothing to do' : 'No step yet'}</span>
  const place = nextStepPlace(step, contextOf(p).destinationOf(step.destinationKey).label)
  return (
    <div className={styles.step}>
      <Link className={styles.stepLabel} href={inBusiness(step.href)} title={`Open ${step.label} for ${data.sku} in the studio`} onClick={(e) => e.stopPropagation()}>
        {step.label}
      </Link>
      {/* Compact rows hold two lines; the message stays in the link's hover title there. */}
      {density !== 'compact' && step.message && <span className={styles.stepMessage} title={step.message}>{step.message}</span>}
      <span className={styles.stepPlace}>{place}</span>
    </div>
  )
}

/* ── Checked ────────────────────────────────────────────────────────────────────────────────────────────────────── */

export function CheckedCell(p: CellParams) {
  const data = dataOf(p)
  if (!data) return null
  return (
    <div className={styles.checked}>
      {data.pending && <Pill tone="info" size="sm">Checking…</Pill>}
      <span title={absoluteTime(data.computedAt)}>{relativeTime(data.computedAt, contextOf(p).now())}</span>
    </div>
  )
}

/* ── The family footer (a full-width row) ───────────────────────────────────────────────────────────────────────── */

export function ReadinessFamilyFooter(p: CellParams) {
  const data = p.data
  if (!isReadinessFooter(data)) return null
  const capped = data.total > data.shown
  return (
    <FamilyFooterFrame
      shown={data.shown}
      total={data.total}
      action={
        <Button asChild size="sm" variant="secondary">
          <Link href={contextOf(p).familyHref(data.parentId)} target="_blank" rel="noopener noreferrer">
            {capped ? `View all ${data.total.toLocaleString('en')}` : 'Open family'} <ExternalLink size={13} aria-hidden />
          </Link>
        </Button>
      }
    />
  )
}

/* ── Column definitions ─────────────────────────────────────────────────────────────────────────────────────────── */

/** The page's columns, in order, for the Customise dialog. Product and Actions stay. */
export const READINESS_COLUMN_SPECS = [
  { key: 'product', label: 'Product', locked: true },
  { key: 'markets', label: 'Markets' },
  { key: 'nextStep', label: 'Next step' },
  { key: 'checked', label: 'Checked' },
  { key: 'actions', label: 'Actions', locked: true },
] as const

/** The tree column. Frozen left at a fixed width (a pinned column ignores `flex`); Markets takes the rest. */
export function readinessTreeColumn(): ColDef<ReadinessGridRow> {
  return {
    headerName: 'Product',
    // Products' own minimum: the photo, the name and the SKU fit; Markets gets the rest of the width.
    width: 320,
    minWidth: 280,
    pinned: 'left',
    lockPinned: true,
    lockPosition: 'left',
    lockVisible: true,
    suppressMovable: true,
    sortable: false,
    cellClass: 'nds-ag-cell',
    valueGetter: (v) => { const d = v.data && !isReadinessFooter(v.data) ? v.data : null; return d ? d.name || d.sku : null },
    cellRenderer: ReadinessTreeCell,
  }
}

export function readinessColumns(ctx: ReadinessGridContext, { fill = true }: { fill?: boolean } = {}): ColDef<ReadinessGridRow>[] {
  const row = (v: { data?: ReadinessGridRow }) => (v.data && !isReadinessFooter(v.data) ? v.data : null)
  return [
    {
      colId: 'markets',
      headerName: 'Markets',
      // Fills the free width, or a fixed width where there is none (`marketsWidth.ts`).
      ...(fill ? { flex: 1 } : { width: MARKETS_FIXED_WIDTH }),
      minWidth: 320,
      sortable: false,
      // Chips wrap; the row grows past its density height only when they need the room (AG takes the larger).
      autoHeight: true,
      cellClass: 'nds-ag-cell',
      valueGetter: (v) => {
        const d = row(v)
        return d ? orderedChips(d.chips, ctx.destinations()).map((c) => chipText(c, ctx.destinationOf(c.destinationKey).label)).join(', ') : null
      },
      cellRenderer: MarketChipsCell,
    },
    {
      colId: 'nextStep',
      headerName: 'Next step',
      width: 260,
      minWidth: 220,
      sortable: false,
      cellClass: 'nds-ag-cell',
      valueGetter: (v) => row(v)?.nextStep?.label ?? null,
      cellRenderer: NextStepCell,
    },
    {
      colId: 'checked',
      headerName: 'Checked',
      width: 120,
      sortable: false,
      cellClass: 'nds-ag-cell',
      valueGetter: (v) => row(v)?.computedAt ?? null,
      cellRenderer: CheckedCell,
    },
    {
      ...actionsColumn<ReadinessGridRow>({
        prefsLabel: 'Actions',
        primary: [
          {
            id: 'fix',
            label: 'Fix',
            onClick: (data) => {
              const d = isReadinessFooter(data) ? null : data
              const key = d ? fixDestination(d) : null
              if (d && key) ctx.openFix(d, key)
            },
            disabled: (data) => (isReadinessFooter(data) ? 'Not a product' : fixHeldReason(data)),
            ariaLabel: (data) => (isReadinessFooter(data) ? 'Fix' : `Fix ${data.sku}`),
          },
          {
            id: 'edit',
            label: 'Edit',
            href: (data) => (isReadinessFooter(data) ? '#' : inBusiness(data.editorHref)),
            ariaLabel: (data) => (isReadinessFooter(data) ? 'Edit' : `Edit ${data.sku} in the studio`),
          },
        ],
      }),
      sortable: false,
    },
  ]
}
