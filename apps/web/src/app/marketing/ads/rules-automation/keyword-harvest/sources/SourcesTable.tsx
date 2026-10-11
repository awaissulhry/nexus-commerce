'use client'

/**
 * Widths at 1440 (card 1312 px): tick 43 + 250 + Product (flex 2, ≥ 160) + Portfolio and Rules (flex 1, ≥ 110 / 120) + 90 + 104
 * + 120 + 130 + ⋯ 56 — the names fill the card, no empty strip before the ⋯. The three counts sit under one "Last N d" header (the read's window) (audit S9: the window in the header;
 * "Selling" counts terms, the "Selling groups" tile counts ad groups).
 *
 * Keyword Harvest page, Sources view — the one table (2026-10-11, lane HRULES): the /products recipe (tick boxes, header
 * select-page, a bulk bar on selection) over the ad groups that feed search terms. Ad group (its link, its kind and its
 * campaign) · Product · Portfolio · Rules · Last 30 d (Terms · Selling · Harvested) · Harvest from here, and the ⋯ menu. Every
 * name is a link; a rule opens its detail on the Rules view of this page.
 *
 * Stable grid options (GDS decision 12): module-constant columns; the cells read the view's handlers from AG's `context`.
 */
import { memo } from 'react'
import { Tag, Tooltip } from '@/design-system/primitives'
import { EntityLinks, type EntityLinkComponent, type MenuItemDef } from '@/design-system/components'
import {
  GridNoRowsOverlay, NexusGrid, actionsColumn, entityLinksColumn, gridSelection, integerColumn, keepFromGrid,
  type ColDef, type ColGroupDef, type ICellRendererParams, type NexusGridProps,
} from '@/design-system/grid'
import Link from '@/lib/workspaces/Link'
import { whenWords } from '../../bid/_shared/format'
import type { HarvestSourceRow } from '../_shared/types'
import { harvestingWord, roleWord, windowWord } from './sourcesModel'
import styles from '../../bid/bid.module.css'
import own from './sources.module.css'

/** What the view hands the grid (a ref that never changes identity). */
export interface SourcesHandlers {
  market: string
  /** The counts' window in days (the read's `windowDays`): the "Last N d" header says it. */
  windowDays: number
  /** Why the rule and harvesting actions cannot be used (permission), or null. */
  held: string | null
  assign(row: HarvestSourceRow): void
  detach(row: HarvestSourceRow): void
  pause(row: HarvestSourceRow, pause: boolean): void
}
export interface SourcesHandlersRef { readonly current: SourcesHandlers }

/** A grid row: the source as read and the view's handlers (the ⋯ menu reads them from the row). */
export interface SourceGridRow { id: string; row: HarvestSourceRow; h: SourcesHandlersRef }

type Cell = ICellRendererParams<SourceGridRow> & { context: SourcesHandlersRef }
const WorkspaceLink = Link as unknown as EntityLinkComponent
const ONE = { one: 'item', many: 'items' }
const RULE_NOUN = { one: 'rule', many: 'rules' }

/** A rule's detail on this page's Rules view (the workspace link adds `/w/<id>`). */
export function ruleHref(id: string, market: string): string {
  const q = new URLSearchParams({ view: 'rules', rule: id, tab: 'overview' })
  if (market && market !== 'all') q.set('market', market)
  return `/marketing/ads/rules-automation/keyword-harvest?${q.toString()}`
}

const AdGroupCell = memo(function AdGroupCell({ data: g, eGridCell }: Cell) {
  if (!g) return null
  const data = g.row
  const back = eGridCell ? () => eGridCell.focus() : undefined
  return (
    <span className={styles.two} onClickCapture={keepFromGrid}>
      <span className={styles.line}><EntityLinks items={[data.adGroup]} noun={ONE} linkAs={WorkspaceLink} returnFocus={back} /></span>
      <span className={styles.subline}>
        <Tag>{roleWord(data.role)}</Tag>
        <EntityLinks items={[data.campaign]} noun={ONE} linkAs={WorkspaceLink} returnFocus={back} />
      </span>
    </span>
  )
})

/** A name as a link that takes a second line before it is cut (re-audit S14); the whole name on hover. */
function TwoLineLink({ name, href }: { name: string; href: string | null | undefined }) {
  return (
    <span className={own.cell} onClickCapture={keepFromGrid}>
      {href
        ? <WorkspaceLink href={href} className={`nds-entitylink ${own.clamp2}`} title={name}>{name}</WorkspaceLink>
        : <span className={own.clamp2} title={name}>{name}</span>}
    </span>
  )
}

const ProductCell = memo(function ProductCell({ data: g }: Cell) {
  const p = g?.row.product
  if (!p) return <span className={styles.muted}>—</span>
  return <TwoLineLink name={p.name} href={p.href} />
})

const RulesCell = memo(function RulesCell({ data: g, context, eGridCell }: Cell) {
  if (!g) return null
  const data = g.row
  const items = data.rules.map((r) => ({ ...r, href: ruleHref(r.id, context.current.market) }))
  // One rule: its whole name on two lines; several: the count chip that opens the list of links.
  if (items.length === 1) return <TwoLineLink name={items[0].name} href={items[0].href} />
  return (
    <span className="nds-cell-entitylinks" onClickCapture={keepFromGrid}>
      <EntityLinks items={items} noun={RULE_NOUN} linkAs={WorkspaceLink} listLabel={`Rules on ${data.adGroup.name}`} returnFocus={eGridCell ? () => eGridCell.focus() : undefined} />
    </span>
  )
})

const HarvestingCell = memo(function HarvestingCell({ data: g }: Cell) {
  if (!g) return null
  const data = g.row
  if (!data.paused) return <Tag tone="success">On</Tag>
  const hint = `Off since ${whenWords(data.paused.at)}: no harvest takes a term from here`
  return <Tooltip label={hint} portal><span tabIndex={-1} aria-label={`Off: ${hint}`}><Tag tone="warning">Off</Tag></span></Tooltip>
})

function menuItems(g: SourceGridRow): MenuItemDef[] {
  const r = g.row
  const h = g.h.current
  const held = h.held
  return [
    { id: 'assign', label: 'Assign rule…', disabled: !!held, description: held ?? undefined, onSelect: () => h.assign(r) },
    ...(r.rules.length ? [{ id: 'detach', label: 'Detach rule…', disabled: !!held, description: held ?? undefined, onSelect: () => h.detach(r) }] : []),
    r.paused
      ? { id: 'resume', label: 'Harvest from here: on…', disabled: !!held, description: held ?? undefined, onSelect: () => h.pause(r, false) }
      : { id: 'pause', label: 'Harvest from here: off…', disabled: !!held, description: held ?? undefined, onSelect: () => h.pause(r, true) },
    ...(r.adGroup.href ? [{ id: 'open', label: 'Open ad group', href: r.adGroup.href }] : []),
    ...(r.campaign.href ? [{ id: 'terms', label: 'Search terms', href: `${r.campaign.href}?tab=search-terms` }] : []),
  ]
}

const ACTIONS: ColDef<SourceGridRow> = actionsColumn<SourceGridRow>({ items: menuItems, menuLabel: (g) => `Actions for ${g.row.adGroup.name}` })

const AD_GROUP: ColDef<SourceGridRow> = {
  colId: 'adGroup', headerName: 'Ad group', pinned: 'left', width: 250, minWidth: 200,
  valueGetter: (p) => p.data?.row.adGroup.name ?? '',
  getQuickFilterText: (p) => (p.data ? `${p.data.row.adGroup.name} ${p.data.row.campaign.name} ${roleWord(p.data.row.role)}` : ''),
  cellRenderer: AdGroupCell,
  headerTooltip: 'The ad group that finds search terms, its kind (Auto · Broad · Phrase · Product) and its campaign.',
}
const linkCol = (colId: 'product' | 'portfolio', header: string, width: number): ColDef<SourceGridRow> => ({
  ...entityLinksColumn<SourceGridRow>(colId, { header, noun: ONE, linkAs: WorkspaceLink }),
  field: undefined, colId, width,
  valueGetter: (p) => { const v = p.data?.row[colId]; return v ? [v] : [] },
})
// The names take the room the card has (re-audit S14): product twice the share of portfolio and rules.
const PRODUCT: ColDef<SourceGridRow> = { ...linkCol('product', 'Product', 160), width: undefined, flex: 2, minWidth: 180, cellRenderer: ProductCell }
const PORTFOLIO: ColDef<SourceGridRow> = { ...linkCol('portfolio', 'Portfolio', 120), width: undefined, flex: 1, minWidth: 110 }
const RULES: ColDef<SourceGridRow> = {
  colId: 'rules', headerName: 'Rules', flex: 1, minWidth: 120,
  valueGetter: (p) => p.data?.row.rules.map((r) => r.name).join(', ') ?? '',
  cellRenderer: RulesCell,
  headerTooltip: 'The harvest rules that read this ad group. A rule opens its detail on the Rules view.',
}
/** A count over the read's window (`windowDays`). */
const countCol = (colId: string, header: string, width: number, read: (r: HarvestSourceRow) => number, tip: string): ColDef<SourceGridRow> => ({
  ...integerColumn<SourceGridRow>(colId), field: undefined, colId, headerName: header, width, headerTooltip: tip,
  valueGetter: (p) => (p.data ? read(p.data.row) : null),
})
const TERMS = countCol('terms', 'Terms', 90, (r) => r.terms, 'Search terms it found in the window.')
const CONVERTING = countCol('selling', 'Selling', 104, (r) => r.sellingTerms, 'Selling terms: search terms with an order in the window.')
const HARVESTED = countCol('harvested', 'Harvested', 120, (r) => r.harvested, 'Terms harvested from it in the window.')
const HARVESTING: ColDef<SourceGridRow> = {
  colId: 'harvesting', headerName: 'Harvest here', width: 130,
  valueGetter: (p) => (p.data ? harvestingWord(p.data.row) : ''),
  cellRenderer: HarvestingCell,
  headerTooltip: 'Harvest from here: Off = no harvest (the page, Claude, a rule or the Brain) takes a term from this ad group.',
}

/** The three counts under one header: the window said once (audit S9). */
const LAST_30: ColGroupDef<SourceGridRow> = {
  groupId: 'window', headerName: `Last ${windowWord(null)}`, children: [TERMS, CONVERTING, HARVESTED],
  headerValueGetter: (p) => `Last ${windowWord((p.context as SourcesHandlersRef | undefined)?.current?.windowDays)}`,
}

export const SOURCE_COLUMNS: Array<ColDef<SourceGridRow> | ColGroupDef<SourceGridRow>> = [AD_GROUP, PRODUCT, PORTFOLIO, RULES, LAST_30, HARVESTING, ACTIONS]
export const SOURCE_PHONE_COLUMNS: Array<ColDef<SourceGridRow> | ColGroupDef<SourceGridRow>> = [
  { ...AD_GROUP, width: 170, minWidth: 150 }, { ...HARVESTING, width: 110 }, LAST_30, RULES, PRODUCT, PORTFOLIO, { ...ACTIONS, pinned: null, lockPinned: false },
]
export const SOURCE_PREFERENCE_COLUMNS: ReadonlyArray<{ key: string; label: string; locked?: boolean }> = [
  { key: 'adGroup', label: 'Ad group', locked: true },
  { key: 'product', label: 'Product' },
  { key: 'portfolio', label: 'Portfolio' },
  { key: 'rules', label: 'Rules' },
  { key: 'terms', label: 'Terms' },
  { key: 'selling', label: 'Selling' },
  { key: 'harvested', label: 'Harvested' },
  { key: 'harvesting', label: 'Harvest from here' },
]

const ROW_ID: NonNullable<NexusGridProps<SourceGridRow>['getRowId']> = (p) => p.data.id
const SELECTION = gridSelection<SourceGridRow>({ selectAll: 'currentPage' }) as NexusGridProps<SourceGridRow>['rowSelection']

export function SourcesTable(p: {
  rows: SourceGridRow[]
  context: SourcesHandlersRef
  phone: boolean
  selectable: boolean
  pageSize: number
  noRowsParams: NexusGridProps<SourceGridRow>['noRowsOverlayComponentParams']
  initialState: NexusGridProps<SourceGridRow>['initialState']
  columnDialog: NexusGridProps<SourceGridRow>['columnDialog']
  onGridReady: NonNullable<NexusGridProps<SourceGridRow>['onGridReady']>
  onPaginationChanged: NonNullable<NexusGridProps<SourceGridRow>['onPaginationChanged']>
  onSelectionChanged: NonNullable<NexusGridProps<SourceGridRow>['onSelectionChanged']>
}) {
  return (
    <NexusGrid<SourceGridRow>
      domLayout="autoHeight"
      suppressCellFocus={false}
      rowData={p.rows}
      getRowId={ROW_ID}
      columnDefs={p.phone ? SOURCE_PHONE_COLUMNS : SOURCE_COLUMNS}
      rowSelection={p.selectable ? SELECTION : undefined}
      context={p.context}
      noRowsOverlayComponent={GridNoRowsOverlay}
      noRowsOverlayComponentParams={p.noRowsParams}
      initialState={p.initialState}
      columnDialog={p.columnDialog}
      pagination
      paginationPageSize={p.pageSize}
      paginationPageSizeSelector={false}
      suppressPaginationPanel
      onGridReady={p.onGridReady}
      onPaginationChanged={p.onPaginationChanged}
      onSelectionChanged={p.onSelectionChanged}
    />
  )
}
