'use client'

/**
 * Listing readiness — the grid's columns and cells, on the design system's cell library.
 *
 *   Product    the tree column: the DS identity cell (expander · photo · name → studio · SKU · "N variations"), drawn
 *              the way the Products page draws it (`next/columns.tsx` `ProductCell`, `next/ProductTreeCell.tsx`).
 *   Markets    one chip per destination — a DS `Pill` that is a real button; its tone and word are `readinessMeta`,
 *              its mark what the channel shows (`liveMarks.ts`: ● Active · ◐ Mixed · ○ not selling · ▲ a problem).
 *   On the channel  the row's listings on the channel, summed over its chips ("18 Active · 2 Not listed"). Only when
 *              the page has live data (the live layer, 2026-10-25).
 *   Status · Price · Qty · Channel ID · Last push · Synced · Channel messages — a store or market page's per-listing
 *              columns (step 4, `listingColumns.ts`): the row's main listings there, in the design system's words.
 *   Next step  the most urgent problem, a link to the exact field in the studio, and where it is.
 *   Checked    how old the check is; "Checking…" while Nexus rebuilds it.
 *   Actions    Open (the Listing window) · Edit (the studio) · ⋯ (the row menu, the same list as the right-click menu:
 *              `listingsBulk.ts` `rowMenuItems`) — the DS `actionsColumn`.
 *
 * Cells read the page through AG's `context` (`ReadinessGridContext`): the destination labels, the Listing window and the
 * family page link. Every verdict, count and order is the API's. A chip opens the Listing window on its destination: a ▲
 * chip on its "On the channel" tab, every other on Readiness (live layer step 5).
 */
import { Fragment, type ReactElement } from 'react'
import { Circle, Contrast, ExternalLink, TriangleAlert } from 'lucide-react'
import type { ReadinessDestination } from '@nexus/shared/listing-readiness'
import type { MenuItemDef } from '@/design-system/components'

import Link from '@/lib/workspaces/Link'
import { browserWorkspaceId, workspaceHref } from '@/lib/workspaces/paths'
import { Button, Pill, Spinner, Tag } from '@/design-system/primitives'
import {
  EmptyValue,
  ExpandButton,
  ExpandSlot,
  FamilyFooterFrame,
  IdentityCell,
  PublishStatusPill,
  SellingStatePill,
  SkuTag,
  actionsColumn,
  gridFilterDef,
  numericColumn,
  readinessMeta,
  useExpanded,
  useGridDensity,
  type ColDef,
  type ICellRendererParams,
} from '@/design-system/grid'

import styles from './readiness.module.css'
import { chipGlyph, LIVE_COLUMN, onChannelWords, type ChipGlyph } from './liveMarks'
import { CHANNEL_STATE_OPTIONS } from './liveFilters'
import {
  DESC_FIRST_COLUMNS,
  channelIdWords,
  lastPushMeta,
  listingColumnLabel,
  listingColumnsShown,
  marketsLabel,
  messageWords,
  onChannelShown,
  pinnedWords,
  priceWords,
  qtyWords,
  statusWords,
  type ListingColumn,
  type ListingFacts,
  type PageScope,
} from './listingColumns'
import { chipAriaLabel, chipLines, chipText, nextStepPlace, orderedChips, plural, type PlacedChip } from './marketChips'
import { openDestination, openHeldReason, tabForChip, type ListingTab } from './listingDialogModel'
import { MARKETS_FIXED_WIDTH } from './marketsWidth'
import { absoluteTime, relativeTime } from './relativeTime'
import { canExpand, isFamilyRow, isMemberRow, isReadinessFooter, type ReadinessDataRow, type ReadinessGridRow } from './readinessRows'

/** What the cells ask of the page. One stable object (AG `context`); its functions read the page's current state. */
export interface ReadinessGridContext {
  /** The destinations of the latest answer, in chip order. */
  destinations: () => readonly ReadinessDestination[]
  destinationOf: (key: string) => ReadinessDestination
  /**
   * Open the Listing window for this row on this destination: on `tab` (default Readiness), knowing the grid row it came
   * from (`rowId`, for Prev / Next; the page finds it when not given).
   */
  openListing: (row: ReadinessDataRow, destinationKey: string, opts?: { rowId?: string | null; tab?: ListingTab }) => void
  /** The bare address of one family's page (`?parent=`), with the current filters. */
  familyHref: (rootId: string) => string
  /** A family's own page: its members are flat, nothing folds open. */
  flat: () => boolean
  /** The latest answer carries live data (`pageHasLive`): the chips draw their live marks. */
  liveShown: () => boolean
  /** Step 4: the row's main listings on the page's store and market, as one (`listingFacts`); null = none. */
  listingFactsOf: (row: ReadinessDataRow) => ListingFacts | null
  /** Step 4: the page's store (`AMAZON` …), or null on /listings. */
  pageChannel: () => string | null
  now: () => number
  /**
   * The row's menu (⋯ and right-click read the same list): on `destinationKey` when the row has that chip (the one
   * right-clicked), else where Open opens.
   */
  rowMenu: (row: ReadinessDataRow, destinationKey: string | null) => MenuItemDef[]
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

/** The glyph in the chip's icon slot. The sentence says it in words; the glyph is for the eye. */
const GLYPH_ICON: Record<Exclude<ChipGlyph, 'dot' | 'none'>, ReactElement> = {
  pending: <Spinner size={9} />,
  mixed: <Contrast size={10} strokeWidth={2.5} aria-hidden />,
  off: <Circle size={10} strokeWidth={2.5} aria-hidden />,
  problem: <TriangleAlert size={10} strokeWidth={2.5} aria-hidden />,
}

export function MarketChipsCell(p: CellParams) {
  const data = dataOf(p)
  if (!data) return null
  const ctx = contextOf(p)
  const chips = orderedChips(data.chips, ctx.destinations())
  if (chips.length === 0) return <span className={styles.none}>No markets</span>
  const liveShown = ctx.liveShown()
  const pill = ({ chip, label, text }: PlacedChip) => {
    const sentence = chipAriaLabel(chip, label, ctx.destinationOf(chip.destinationKey).channel)
    const tone = readinessMeta(chip.state, 'scope').tone
    const open = () => ctx.openListing(data, chip.destinationKey, { rowId: p.node.id ?? null, tab: tabForChip(chip) })
    // The colour stays the readiness colour; the mark is the channel's (a waiting rebuild keeps the DS spinner).
    const glyph = chipGlyph(chip, liveShown)
    if (glyph === 'dot' || glyph === 'none') {
      return (
        <Pill key={chip.destinationKey} tone={tone} dot={glyph === 'dot'} onClick={open} aria-label={sentence} title={sentence} data-destination-key={chip.destinationKey}>
          {text}
        </Pill>
      )
    }
    return (
      <Pill key={chip.destinationKey} tone={tone} icon={GLYPH_ICON[glyph]} onClick={open} aria-label={sentence} title={sentence} data-destination-key={chip.destinationKey}>
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

/* ── On the channel ─────────────────────────────────────────────────────────────────────────────────────────────── */

/** The row's listings on the channel: the states on one line, the problems under them. A dash: no live data here. */
export function OnChannelCell(p: CellParams) {
  const data = dataOf(p)
  if (!data) return null
  const words = onChannelWords(data.chips)
  if (!words) return <EmptyValue />
  return (
    <div className={styles.onChannel} title={words.text}>
      {words.states && <span className={styles.onChannelStates}>{words.states}</span>}
      {words.problems && <span className={styles.onChannelProblems}>{words.problems}</span>}
    </div>
  )
}

/* ── The per-listing columns (step 4) ───────────────────────────────────────────────────────────────────────────── */

const factsOf = (p: CellParams) => { const d = dataOf(p); return d ? { data: d, facts: contextOf(p).listingFactsOf(d) } : null }

/** Status: the design system's selling pill; a family whose listings differ says Mixed, the counts in its tooltip. */
export function ListingStatusCell(p: CellParams) {
  const got = factsOf(p)
  if (!got) return null
  if (!got.facts) return <EmptyValue />
  const words = statusWords(got.facts)
  return <span title={words.title}><SellingStatePill pill={{ label: words.label, tone: words.tone, glyph: 'dot' }} /></span>
}

/** Price: one price or a range, in the listings' currency; "Pinned" when it does not follow the master price. */
export function ListingPriceCell(p: CellParams) {
  const got = factsOf(p)
  if (!got) return null
  const text = got.facts && priceWords(got.facts)
  if (!got.facts || !text) return <EmptyValue />
  const pinned = pinnedWords(got.facts)
  return (
    <span className={styles.listingValue} title={pinned ? `${text}. ${pinned.title}` : `${text}. Follows the master price.`}>
      {pinned && <Tag>{pinned.label}</Tag>}
      <span>{text}</span>
    </span>
  )
}

/** Qty: the quantity (a family's total, "20 var."; a range across markets, never a sum) and its note. */
export function ListingQtyCell(p: CellParams) {
  const got = factsOf(p)
  if (!got) return null
  const words = got.facts && qtyWords(got.facts, { family: isFamilyRow(got.data) && got.data.isParent, channel: contextOf(p).pageChannel() })
  if (!words) return <EmptyValue />
  return (
    <span className={styles.listingValue} title={words.title}>
      {words.aside && <span className={styles.listingAside}>{words.aside}</span>}
      <span>{words.text}</span>
    </span>
  )
}

/** Channel ID: the parent ASIN or eBay Item ID, a link to the live listing; "per variation" when a family has none of its own. */
export function ListingChannelIdCell(p: CellParams) {
  const got = factsOf(p)
  if (!got) return null
  const words = got.facts && channelIdWords(got.facts)
  if (!words) return <EmptyValue />
  if ('perVariation' in words) return <span className={styles.none} title="Each variation has its own id on the channel">per variation</span>
  if (!words.url) return <span className={styles.listingId}>{words.id}</span>
  return (
    <a className={styles.listingLink} href={words.url} target="_blank" rel="noopener noreferrer" title={`Open ${words.id} on the channel (new tab)`}
      onClick={(e) => e.stopPropagation()}>
      {words.id} <ExternalLink size={11} aria-hidden />
    </a>
  )
}

/** Last push: the design system's publish pill — the worst, "3 of 20 failed" on a family. */
export function ListingLastPushCell(p: CellParams) {
  const got = factsOf(p)
  if (!got) return null
  const meta = got.facts && lastPushMeta(got.facts.push)
  if (!meta) return <EmptyValue />
  return <span title={meta.hint}><PublishStatusPill meta={meta} /></span>
}

/** Synced: the oldest sync of the row's listings here. */
export function ListingSyncedCell(p: CellParams) {
  const got = factsOf(p)
  if (!got) return null
  const at = got.facts?.syncedOldest
  if (!at) return <EmptyValue />
  return <span className={styles.checked} title={absoluteTime(at)}>{relativeTime(at, contextOf(p).now())}</span>
}

/** Channel messages: the open errors and warnings of the row's listings here. */
export function ListingMessagesCell(p: CellParams) {
  const got = factsOf(p)
  if (!got) return null
  if (!got.facts) return <EmptyValue />
  const words = messageWords(got.facts)
  return <span className={words.total ? styles.listingValue : styles.none} title={words.title}>{words.total.toLocaleString('en')}</span>
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

/** What the page's columns may do (step 4): which a header click sorts, which carry a filter. */
export interface ReadinessColumnOptions {
  fill?: boolean
  live?: boolean
  scope?: PageScope
  listingColumns?: readonly ListingColumn[]
  sortable?: ReadonlySet<string>
  filterable?: boolean
  channel?: string | null
}

/** The tree column. Frozen left at a fixed width (a pinned column ignores `flex`); Markets takes the rest. A header click sorts by name (step 4). */
export function readinessTreeColumn({ sortable = false }: { sortable?: boolean } = {}): ColDef<ReadinessGridRow> {
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
    ...(sortable ? { sortable: true, sortingOrder: ['asc', 'desc', null] } : { sortable: false }),
    cellClass: 'nds-ag-cell',
    valueGetter: (v) => { const d = v.data && !isReadinessFooter(v.data) ? v.data : null; return d ? d.name || d.sku : null },
    cellRenderer: ReadinessTreeCell,
  }
}

/**
 * The columns. `live`: the page has live data — only then is there an "On the channel" column (an older API, or a
 * person without `listings.view`, sees the page as it was).
 */
export function readinessColumns(ctx: ReadinessGridContext, options: ReadinessColumnOptions = {}): ColDef<ReadinessGridRow>[] {
  const { fill = true, live = false, scope = 'all', listingColumns = [], sortable = new Set<string>(), filterable = false, channel = null } = options
  const row = (v: { data?: ReadinessGridRow }) => (v.data && !isReadinessFooter(v.data) ? v.data : null)
  // A header click sorts on the server (`SORT_OF_COLUMN`); Next step's first click is the most problems.
  const sorting = (colId: string): Partial<ColDef<ReadinessGridRow>> => (sortable.has(colId)
    ? { sortable: true, sortingOrder: DESC_FIRST_COLUMNS.includes(colId) ? ['desc', 'asc', null] : ['asc', 'desc', null] } : { sortable: false })
  const onChannel: ColDef<ReadinessGridRow>[] = live ? [{
    colId: LIVE_COLUMN,
    headerName: 'On the channel',
    width: 210,
    minWidth: 170,
    sortable: false,
    // A market page's Status says it per listing: there it starts hidden (Customise brings it back).
    ...(onChannelShown(scope) ? {} : { initialHide: true }),
    cellClass: 'nds-ag-cell',
    valueGetter: (v) => { const d = row(v); return d ? onChannelWords(d.chips)?.text ?? null : null },
    cellRenderer: OnChannelCell,
  }] : []
  const listing = listingColumnDefs(ctx, { scope, columns: listingColumns, sorting, filterable, channel })
  return [
    {
      colId: 'markets',
      headerName: marketsLabel(scope),
      // Fills the free width, or a fixed width where there is none (`marketsWidth.ts`).
      ...(fill ? { flex: 1 } : { width: MARKETS_FIXED_WIDTH }),
      minWidth: 320,
      ...sorting('markets'),
      // Chips wrap; the row grows past its density height only when they need the room (AG takes the larger).
      autoHeight: true,
      cellClass: 'nds-ag-cell',
      valueGetter: (v) => {
        const d = row(v)
        return d ? orderedChips(d.chips, ctx.destinations()).map((c) => chipText(c, ctx.destinationOf(c.destinationKey).label)).join(', ') : null
      },
      cellRenderer: MarketChipsCell,
    },
    ...listing,
    ...onChannel,
    {
      colId: 'nextStep',
      headerName: 'Next step',
      width: 260,
      minWidth: 220,
      ...sorting('nextStep'),
      cellClass: 'nds-ag-cell',
      valueGetter: (v) => row(v)?.nextStep?.label ?? null,
      cellRenderer: NextStepCell,
    },
    {
      colId: 'checked',
      headerName: 'Checked',
      width: 120,
      ...sorting('checked'),
      cellClass: 'nds-ag-cell',
      valueGetter: (v) => row(v)?.computedAt ?? null,
      cellRenderer: CheckedCell,
    },
    {
      ...actionsColumn<ReadinessGridRow>({
        prefsLabel: 'Actions',
        primary: [
          {
            id: 'open',
            label: 'Open',
            onClick: (data) => {
              const d = isReadinessFooter(data) ? null : data
              const key = d ? openDestination(d) : null
              // The next step is a readiness problem: Readiness. Otherwise the chip it opens on says (▲ → On the channel).
              if (d && key) ctx.openListing(d, key, { tab: d.nextStep ? 'readiness' : tabForChip(d.chips.find((c) => c.destinationKey === key)) })
            },
            disabled: (data) => (isReadinessFooter(data) ? 'Not a product' : openHeldReason(data)),
            ariaLabel: (data) => (isReadinessFooter(data) ? 'Open' : `Open ${data.sku}`),
          },
          {
            id: 'edit',
            label: 'Edit',
            href: (data) => (isReadinessFooter(data) ? '#' : inBusiness(data.editorHref)),
            ariaLabel: (data) => (isReadinessFooter(data) ? 'Edit' : `Edit ${data.sku} in the studio`),
          },
        ],
        items: (data) => (isReadinessFooter(data) ? [] : ctx.rowMenu(data, null)),
        menuLabel: (data) => (isReadinessFooter(data) ? 'More actions' : `More actions for ${data.sku}`),
      }),
      sortable: false,
    },
  ]
}

/**
 * The per-listing columns (step 4), in `LISTING_COLUMNS` order. On a store page they start hidden; on a market page
 * with one destination Status, Price, Qty and Channel ID carry a filter (they write the address's keys) and Status,
 * Price, Qty and Synced sort on the server.
 */
function listingColumnDefs(ctx: ReadinessGridContext, o: { scope: PageScope; columns: readonly ListingColumn[]; channel: string | null; filterable: boolean;
  sorting: (colId: string) => Partial<ColDef<ReadinessGridRow>> }): ColDef<ReadinessGridRow>[] {
  const facts = (v: { data?: ReadinessGridRow }) => (v.data && !isReadinessFooter(v.data) ? ctx.listingFactsOf(v.data) : null)
  const hidden = listingColumnsShown(o.scope) ? {} : { initialHide: true }
  const base = (column: ListingColumn, width: number): ColDef<ReadinessGridRow> => ({
    colId: column, headerName: listingColumnLabel(column, o.channel), width, minWidth: Math.min(width, 96), cellClass: 'nds-ag-cell', ...hidden, ...o.sorting(column),
  })
  const filter = (def: Partial<ColDef<ReadinessGridRow>>): Partial<ColDef<ReadinessGridRow>> => (o.filterable ? def : {})
  const defs: Record<ListingColumn, ColDef<ReadinessGridRow>> = {
    status: { ...base('status', 132), valueGetter: (v) => { const f = facts(v); return f ? statusWords(f).label : null }, cellRenderer: ListingStatusCell,
      ...filter(gridFilterDef('set', { options: CHANNEL_STATE_OPTIONS.map((c) => ({ value: c.value, label: c.label })) })) },
    price: { ...base('price', 190), ...numericColumn, valueGetter: (v) => { const f = facts(v); return f ? priceWords(f) : null },
      cellRenderer: ListingPriceCell, ...filter(gridFilterDef('number')) },
    qty: { ...base('qty', 120), ...numericColumn, valueGetter: (v) => facts(v)?.qty?.min ?? null, cellRenderer: ListingQtyCell,
      ...filter(gridFilterDef('number')) },
    channelId: { ...base('channelId', 150), valueGetter: (v) => facts(v)?.externalId ?? null, cellRenderer: ListingChannelIdCell, ...filter(gridFilterDef('text')) },
    lastPush: { ...base('lastPush', 150), valueGetter: (v) => { const f = facts(v); return f ? lastPushMeta(f.push)?.label ?? null : null }, cellRenderer: ListingLastPushCell },
    synced: { ...base('synced', 120), valueGetter: (v) => facts(v)?.syncedOldest ?? null, cellRenderer: ListingSyncedCell },
    messages: { ...base('messages', 170), ...numericColumn, valueGetter: (v) => { const f = facts(v); return f ? messageWords(f).total : null }, cellRenderer: ListingMessagesCell },
  }
  return o.columns.map((column) => defs[column])
}
