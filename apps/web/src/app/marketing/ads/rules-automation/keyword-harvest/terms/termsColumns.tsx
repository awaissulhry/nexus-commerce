'use client'

/**
 * Keyword Harvest page, Terms view — the table's columns and cells (2026-10-11, lane TERMS). One registry
 * (`TERM_COLUMN_SPECS`) names every column once: the grid, Customise and the tests read it, so they cannot drift.
 *
 *   Search term   the term, and under it the match it came from (chip) and its main source campaign (a link; +N sources)
 *   Product       a link
 *   Orders · ACoS · Spend · CPC   the term's window (the bar's own, 60 settled days by default), in the row's currency
 *   Goes to       Portfolio › Campaign › Ad group (the DS EntityPath, links), or "New campaign" with its name on hover
 *   Status        one word and tone (termsModel `statusOf`), the reason on hover
 *   ⋯             Harvest (Ready) · Approve / Reject (Waiting for you) · Undo… (Harvested) · Unskip (Skipped), and the ⋯
 *                 menu: Harvest to…, Skip 7 d / 30 d / for good, Copy term, Open
 *
 * Every name is a link; a click on a row (or Enter on a cell) opens the term's detail. Cells only show: their verbs call
 * the view through AG's `context` (a ref that never changes identity), so the columns stay stable (GDS decision 12).
 * A money key the server left out (no ad-spend permission) reads as a dash.
 */
import { memo } from 'react'
import { Plus } from 'lucide-react'
import { Tag, Tooltip } from '@/design-system/primitives'
import { EntityLinks, EntityPath, type EntityLinkComponent, type MenuItemDef } from '@/design-system/components'
import { actionsColumn, entityLinksKeys, keepFromGrid, type ColDef, type ICellRendererParams, type RowVerb } from '@/design-system/grid'
import Link from '@/lib/workspaces/Link'
import type { HarvestCandidateRow, SkipDays } from '../_shared/types'
import {
  acosText, approveHeld, barWords, decideHeld, goesToText, harvestToHeld, numbersWindowWords, roleWord, rowMoney, rowNumbers, skipHeld, statusOf,
  undoHeld,
} from './termsModel'
import { ProductCell } from '../../_shared/ProductCell'
import styles from './terms.module.css'

/** What the cells ask the view. */
export interface TermsCellHandlers {
  open(row: HarvestCandidateRow): void
  harvest(row: HarvestCandidateRow): void
  harvestTo(row: HarvestCandidateRow): void
  decide(row: HarvestCandidateRow, kind: 'approve' | 'reject'): void
  skip(row: HarvestCandidateRow, days: SkipDays): void
  unskip(row: HarvestCandidateRow): void
  undo(row: HarvestCandidateRow): void
  copy(row: HarvestCandidateRow): void
  /** Why this person may not harvest, decide or undo (permission), or null. */
  manageHeld: string | null
  /** Why a change that reaches Amazon cannot be sent in this row's market (Nexus only reads it), or null. */
  writeHeld(row: HarvestCandidateRow): string | null
}
export interface TermsCellContext { readonly current: TermsCellHandlers }
type Cell = ICellRendererParams<HarvestCandidateRow> & { context?: TermsCellContext }

const WorkspaceLink = Link as unknown as EntityLinkComponent
const CAMPAIGN_NOUN = { one: 'campaign', many: 'campaigns' }
const AD_GROUP_NOUN = { one: 'ad group', many: 'ad groups' }

/** The term, and under it the match it came from and its main source campaign (+N when it ran in more). */
export const TermCell = memo(function TermCell({ data }: Cell) {
  if (!data) return null
  const role = roleWord(data.source?.role)
  const campaigns = data.source ? [data.source.campaign] : []
  const more = Math.max(0, new Set(data.sources.map((s) => s.adGroup.id)).size - 1)
  return (
    <span className={styles.two}>
      <span className={styles.main}><span className={styles.ellipsis} title={data.term}>{data.term}</span></span>
      {(role || campaigns.length > 0) && (
        <span className={styles.subline}>
          {role && <Tag tone="neutral">{role}</Tag>}
          {/* Only the link keeps its click from the row: a tap anywhere else on the line opens the term (NICE). */}
          {campaigns.length > 0 && <span className={`${styles.ellipsis} ${styles.placeWrap}`} onClickCapture={keepFromGrid}><EntityLinks items={campaigns} noun={CAMPAIGN_NOUN} linkAs={WorkspaceLink} /></span>}
          {more > 0 && <span className={styles.muted} title={`Also runs in ${more} more ad ${more === 1 ? 'group' : 'groups'}`}>+{more}</span>}
        </span>
      )}
    </span>
  )
})

const ProductRenderer = memo(function ProductRenderer({ data }: Cell) {
  return data ? <ProductCell product={data.product} /> : null
})

/** Where it goes: the place (links), or the new campaign the harvest would make (its name on hover). */
export const GoesToCell = memo(function GoesToCell({ data }: Cell) {
  if (!data) return null
  const d = data.destination
  if (d?.kind === 'new') {
    return (
      <Tooltip label={d.plan.name} portal>
        <span className={styles.newPlace} tabIndex={-1} role="img" aria-label={`New campaign: ${d.plan.name}`}><Plus size={12} aria-hidden /> New campaign</span>
      </Tooltip>
    )
  }
  if (d?.kind !== 'existing') return <span className="nds-cell-muted" role="img" aria-label="No place">—</span>
  // Two lines like the Search term cell (audit M9): the ad group the keyword goes into, and its portfolio › campaign
  // under it — each a link; Enter follows the ad group, Shift+Enter the campaign (the Bid page's place-cell keys).
  return (
    <span className={styles.two} onClickCapture={keepFromGrid}>
      <span className={styles.ellipsis}><EntityLinks items={[d.adGroup]} noun={AD_GROUP_NOUN} linkAs={WorkspaceLink} /></span>
      <span className={styles.sub}><EntityPath items={[d.portfolio, d.campaign]} linkAs={WorkspaceLink} label="In" /></span>
    </span>
  )
})

export const StatusCell = memo(function StatusCell({ data }: Cell) {
  if (!data) return null
  const s = statusOf(data)
  const tag = <Tag tone={s.tone}>{s.word}</Tag>
  return s.hint ? <span className={styles.fill} title={s.hint} role="img" aria-label={`${s.word}: ${s.hint}`}>{tag}</span> : tag
})

/** Phone: the term's two numbers in one narrow column. */
const PhoneNumbersCell = memo(function PhoneNumbersCell({ data }: Cell) {
  if (!data) return null
  return (
    <span className={styles.two}>
      <span>{rowNumbers(data).orders} · {acosText(rowNumbers(data).acosPct)}</span>
      <span className={styles.sub}>{statusOf(data).word}</span>
    </span>
  )
})

// ── row verbs ─────────────────────────────────────────────────────────────────────────────────────────────────────────

type Ctx = { readonly current: TermsCellHandlers }
const held = (ctx: Ctx, own: string | null): string | null => own ?? ctx.current.manageHeld
const harvestHeldOf = (ctx: Ctx, row: HarvestCandidateRow): string | null => ctx.current.manageHeld ?? ctx.current.writeHeld(row)
/** A change that reaches Amazon: the permission, then the market's write block. */
const sendHeld = (ctx: Ctx, row: HarvestCandidateRow, own: string | null): string | null => own ?? ctx.current.manageHeld ?? ctx.current.writeHeld(row)

/** The visible verbs of a row: the one it waits for. */
export function rowVerbs(ctx: Ctx) {
  return (row: HarvestCandidateRow): readonly [] | readonly [RowVerb<HarvestCandidateRow>] | readonly [RowVerb<HarvestCandidateRow>, RowVerb<HarvestCandidateRow>] => {
    switch (row.state) {
      case 'READY':
      case 'NEEDS_CAMPAIGN':
        return [{ id: 'harvest', label: 'Harvest', tone: 'primary', onClick: (r) => ctx.current.harvest(r), disabled: (r) => harvestHeldOf(ctx, r), ariaLabel: (r) => `Harvest: ${r.term}` }]
      case 'NEEDS_DESTINATION':
        return [{ id: 'harvestTo', label: 'Harvest to…', onClick: (r) => ctx.current.harvestTo(r), disabled: (r) => harvestHeldOf(ctx, r), ariaLabel: (r) => `Harvest to: ${r.term}` }]
      case 'WAITING':
        return [
          { id: 'approve', label: 'Approve', tone: 'primary', onClick: (r) => ctx.current.decide(r, 'approve'), disabled: (r) => sendHeld(ctx, r, approveHeld(r)), ariaLabel: (r) => `Approve: ${r.term}` },
          { id: 'reject', label: 'Reject', onClick: (r) => ctx.current.decide(r, 'reject'), disabled: (r) => held(ctx, decideHeld(r)), ariaLabel: (r) => `Reject: ${r.term}` },
        ]
      case 'HARVESTED':
        return row.lastHarvest ? [{ id: 'undo', label: 'Undo…', onClick: (r) => ctx.current.undo(r), disabled: (r) => sendHeld(ctx, r, undoHeld(r)), ariaLabel: (r) => `Undo harvest: ${r.term}` }] : []
      case 'SKIPPED':
        return [{ id: 'unskip', label: 'Unskip', onClick: (r) => ctx.current.unskip(r), disabled: () => ctx.current.manageHeld, ariaLabel: (r) => `Unskip: ${r.term}` }]
      default:
        return []
    }
  }
}

/**
 * The ⋯ menu of a row (audit S17): only the verbs its state can take — a verb its state rules out is left out, not
 * listed four times with the same reason. A verb held by the person's permission or the market's write block stays,
 * with its reason (it would run for someone else, or in another market).
 */
export function rowMenu(ctx: Ctx, row: HarvestCandidateRow): MenuItemDef[] {
  const item = (id: string, label: string, why: string | null, run: () => void, extra: Partial<MenuItemDef> = {}): MenuItemDef => (why
    ? { id, label, disabled: true, description: why, ...extra }
    : { id, label, onSelect: run, ...extra })
  const manage = ctx.current.manageHeld
  const items: MenuItemDef[] = [item('open', 'Open', null, () => ctx.current.open(row))]
  if (!harvestToHeld(row)) items.push(item('harvestTo', 'Harvest to…', harvestHeldOf(ctx, row), () => ctx.current.harvestTo(row), { title: 'H on the row' }))
  if (row.state === 'SKIPPED') items.push(item('unskip', 'Unskip', manage, () => ctx.current.unskip(row)))
  else if (!skipHeld(row)) {
    items.push(
      item('skip7', 'Skip 7 d', manage, () => ctx.current.skip(row, 7)),
      item('skip30', 'Skip 30 d', manage, () => ctx.current.skip(row, 30)),
      item('skipForGood', 'Skip for good', manage, () => ctx.current.skip(row, null)),
    )
  }
  if (row.state === 'HARVESTED' && !undoHeld(row)) items.push(item('undo', 'Undo harvest…', sendHeld(ctx, row, null), () => ctx.current.undo(row)))
  items.push({ id: 'sep', separator: true }, item('copy', 'Copy term', null, () => ctx.current.copy(row)))
  return items
}

/**
 * The ⋯ column's keys (audit M10): a focused cell answers Enter with the row's first verb (Harvest, Approve, Undo…,
 * Unskip) and Space or Shift+Enter with the ⋯ menu; a focused button keeps its own keys, and Tab walks the cell's
 * buttons before leaving it.
 */
export function actionCellKeys({ event, editing }: { event: { key: string; shiftKey?: boolean; type?: string; target: unknown; preventDefault?: () => void }; editing: boolean }): boolean {
  const target = event.target as (Element & { querySelector?: Element['querySelector'] }) | null
  if (!target || typeof target.closest !== 'function') return false
  if (target.closest('button, a[href]')) return true
  if (editing) return false
  const find = (sel: string) => (typeof target.querySelector === 'function' ? target.querySelector<HTMLElement>(sel) : null)
  const pick = event.key === 'Enter' && !event.shiftKey ? find('.nds-cell-actions > button:not([aria-haspopup]):not([aria-disabled="true"])')
    : event.key === ' ' || (event.key === 'Enter' && event.shiftKey) ? find('.nds-cell-actions button[aria-haspopup]')
      : null
  if (!pick) return false
  if (event.type && event.type !== 'keydown') return true
  event.preventDefault?.()
  pick.click()
  return true
}

// ── the registry ──────────────────────────────────────────────────────────────────────────────────────────────────────

export type TermColumnSpec = { key: string; label: string; locked?: boolean; hidden?: boolean }

export const TERM_COLUMN_SPECS: ReadonlyArray<TermColumnSpec> = [
  { key: 'term', label: 'Search term', locked: true },
  { key: 'product', label: 'Product' },
  { key: 'orders', label: 'Orders' },
  { key: 'acos', label: 'ACoS' },
  { key: 'spend', label: 'Spend' },
  { key: 'cpc', label: 'CPC' },
  { key: 'goesTo', label: 'Goes to' },
  { key: 'status', label: 'Status' },
  { key: 'clicks', label: 'Clicks', hidden: true },
  { key: 'impressions', label: 'Impressions', hidden: true },
  { key: 'sales', label: 'Sales', hidden: true },
  { key: 'startBid', label: 'Start bid', hidden: true },
  { key: 'owner', label: 'Run by', hidden: true },
  { key: 'bar', label: 'Sells', hidden: true },
  { key: 'market', label: 'Market', hidden: true },
]
const LABEL: Record<string, string> = Object.fromEntries(TERM_COLUMN_SPECS.map((c) => [c.key, c.label]))

/** A number of the row's window (since the harvest on a harvested row, S7); its window on hover. */
const NumberCell = memo(function NumberCell({ data, valueFormatted, value }: Cell) {
  if (!data) return null
  const text = valueFormatted ?? (value == null ? '—' : String(value))
  const n = rowNumbers(data)
  // A harvested row's numbers are its keyword's since the harvest: said under them (re-audit N-S8).
  if (n.since != null) return <span className={`${styles.two} ${styles.numEnd}`} title={numbersWindowWords(n)}><span>{text}</span><span className={styles.sub}>since harvest</span></span>
  return <span title={numbersWindowWords(n)}>{text}</span>
})
const numberCol = (colId: string, header: string, get: (r: HarvestCandidateRow) => number | null | undefined, width: number, format: (r: HarvestCandidateRow, v: number | null) => string, tip?: string): ColDef<HarvestCandidateRow> => ({
  colId, headerName: header, width, type: 'rightAligned', headerClass: 'nds-ag-head-num', cellClass: ['nds-ag-cell', 'nds-ag-num'], cellRenderer: NumberCell,
  valueGetter: (p) => (p.data ? get(p.data) ?? null : null),
  valueFormatter: (p) => (p.data ? format(p.data, p.value as number | null) : ''),
  ...(tip ? { headerTooltip: tip } : {}),
})
const countText = (_r: HarvestCandidateRow, v: number | null) => (typeof v === 'number' ? v.toLocaleString('en-IE') : '—')
const moneyOf = (r: HarvestCandidateRow, v: number | null) => rowMoney(r, v)

/** Goes to's keys (M10): Enter follows the ad group, Shift+Enter the campaign; a focused link keeps its own keys. */
export function goesToKeys({ event, editing }: { event: { key: string; shiftKey?: boolean; type?: string; target: unknown; preventDefault?: () => void }; editing: boolean }): boolean {
  const target = event.target as (Element & { querySelectorAll?: Element['querySelectorAll'] }) | null
  if (!target || typeof target.closest !== 'function') return false
  if (target.closest('a[href]')) return true
  if (editing || event.key !== 'Enter' || typeof target.querySelectorAll !== 'function') return false
  const links = target.querySelectorAll<HTMLElement>('a[href]')
  const pick = event.shiftKey ? links[links.length - 1] : links[0]
  if (!pick || (event.shiftKey && links.length < 2)) return false
  if (event.type && event.type !== 'keydown') return true
  event.preventDefault?.()
  pick.click()
  return true
}

/**
 * The columns. Desktop: the specs above, Search term pinned left, ⋯ pinned right. Phone: the term (two lines) and its
 * two numbers — no ticks, no ⋯ (a tap opens the term's sheet). Built once per phone flag (useMemo in the view).
 */
export function termColumns(phone: boolean, ctx: Ctx): ColDef<HarvestCandidateRow>[] {
  const term: ColDef<HarvestCandidateRow> = {
    colId: 'term', headerName: LABEL.term, ...(phone ? { flex: 1, minWidth: 140, wrapText: true, autoHeight: true } : { pinned: 'left' as const, width: 230 }), cellClass: 'nds-ag-cell', cellRenderer: TermCell,
    valueGetter: (p) => p.data?.term ?? '', headerTooltip: 'Enter: open the term · H: Harvest to…',
  }
  if (phone) {
    return [term, { colId: 'phoneNumbers', headerName: 'Orders', width: 92, cellClass: 'nds-ag-cell', cellRenderer: PhoneNumbersCell, valueGetter: (p) => (p.data ? rowNumbers(p.data).orders : 0), suppressHeaderMenuButton: true, headerTooltip: 'Orders · ACoS' }]
  }
  const hidden = new Set(TERM_COLUMN_SPECS.filter((c) => c.hidden).map((c) => c.key))
  const cols: ColDef<HarvestCandidateRow>[] = [
    term,
    {
      colId: 'product', headerName: LABEL.product, width: 130, cellClass: 'nds-ag-cell', cellRenderer: ProductRenderer,
      valueGetter: (p) => p.data?.product.name ?? '',
      suppressKeyboardEvent: entityLinksKeys as ColDef<HarvestCandidateRow>['suppressKeyboardEvent'], headerTooltip: 'Enter: the product',
    },
    numberCol('orders', LABEL.orders, (r) => rowNumbers(r).orders, 100, countText),
    numberCol('acos', LABEL.acos, (r) => rowNumbers(r).acosPct, 92, (_r, v) => acosText(v)),
    numberCol('spend', LABEL.spend, (r) => rowNumbers(r).spendCents, 92, moneyOf),
    numberCol('cpc', LABEL.cpc, (r) => rowNumbers(r).cpcCents, 80, moneyOf, 'Spend ÷ clicks'),
    {
      colId: 'goesTo', headerName: LABEL.goesTo, flex: 1, minWidth: 190, cellClass: 'nds-ag-cell', cellRenderer: GoesToCell,
      valueGetter: (p) => (p.data ? goesToText(p.data) : ''), headerTooltip: 'Enter: the ad group · Shift+Enter: the campaign',
      suppressKeyboardEvent: goesToKeys as ColDef<HarvestCandidateRow>['suppressKeyboardEvent'],
    },
    {
      colId: 'status', headerName: LABEL.status, width: 128, cellClass: 'nds-ag-cell', cellRenderer: StatusCell,
      valueGetter: (p) => (p.data ? statusOf(p.data).word : ''),
    },
    numberCol('clicks', LABEL.clicks, (r) => rowNumbers(r).clicks, 96, countText),
    numberCol('impressions', LABEL.impressions, (r) => r.metrics.impressions, 130, countText),
    numberCol('sales', LABEL.sales, (r) => rowNumbers(r).salesCents, 110, moneyOf),
    numberCol('startBid', LABEL.startBid, (r) => r.startBidCents, 110, moneyOf, 'The bid a harvest starts at: the bid for your ACoS target'),
    { colId: 'owner', headerName: LABEL.owner, width: 140, cellClass: 'nds-ag-cell', valueGetter: (p) => p.data?.owner.name ?? '', headerTooltip: 'Who harvests this term on its own' },
    { colId: 'bar', headerName: LABEL.bar, width: 220, cellClass: 'nds-ag-cell', valueGetter: (p) => (p.data ? `${barWords(p.data.bar.label)} · ${p.data.metrics.windowDays} days` : '') },
    { colId: 'market', headerName: LABEL.market, width: 96, cellClass: 'nds-ag-cell', valueGetter: (p) => p.data?.market ?? '' },
    {
      ...actionsColumn<HarvestCandidateRow>({ primary: rowVerbs(ctx), items: (row) => rowMenu(ctx, row), menuLabel: (row) => `More for ${row.term}` }),
      width: 200,
      suppressKeyboardEvent: actionCellKeys as ColDef<HarvestCandidateRow>['suppressKeyboardEvent'],
    },
  ]
  return cols.map((c) => (hidden.has(c.colId as string) ? { ...c, hide: true } : c))
}
