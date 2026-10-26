'use client'

/**
 * Negative Targeting page, Words view (step 4) — the table's columns and cells, its registry naming every column once (the
 * grid, Customise and the tests read it). A click on a row (or Enter on a cell) opens the word; a number that names a set
 * opens that set in the word's record (Terms → its terms, Places → where it runs, several products → its products).
 *
 *   desktop  ☐ · Word · Terms · Spend · Clicks · Orders · Places · Product · State · Block word + ⋯
 *            (hidden: Impressions, ACoS, CPC, Sold, Out of stock)
 *   phone    the same columns, scrolling sideways in the card (the redesign, D16): Word first (150 px, two lines), no
 *            ticks, the verb last and unpinned; a tap opens the full-screen sheet
 *
 * The redesign (2026-10-26, BRIEF D6, D14): two-line rows; the State is ONE chip with a word in a tone (wordsModel.ts
 * wordStateChip) and, for a 2-word piece one of whose words wastes too, a smaller line under it; "Block word" is a
 * secondary row button (the one blue button of the flow is in its review) and the ⋯ holds Block word · whole campaign and
 * Open record.
 */
import { memo, type MouseEvent } from 'react'
import { Layers, WholeWord } from 'lucide-react'
import { actionsColumn, integerColumn, keepFromGrid, type ColDef, type ICellRendererParams, type RowVerb } from '@/design-system/grid'
import type { MenuItemDef } from '@/design-system/components'
import Link from '@/lib/workspaces/Link'
import { TwoLineLink } from '../../_shared/ProductCell'
import { ownerKeys, verbKeys } from '../waste/cellKeys'
import { Mark, StateChip } from '../waste/marks'
import { acosText, moneyOr, plural } from '../waste/wasteModel'
import { placesWords, productsWords, wordStateChip, wordStateSub, wordStateWord, wordVerb, type WordTab, type WordVerbView } from './wordsModel'
import type { WordRow } from './wordsTypes'
import styles from '../negatives.module.css'
import own from './words.module.css'

export type WordGridRow = WordRow

/** What the cells ask the view (AG's `context`: a ref that never changes identity). */
export interface WordCellHandlers {
  /** Open the word's record on a tab (a count that names a set, the ⋯'s Open record). */
  open(id: string, tab: WordTab): void
  /** Block word (the ad group, or the whole campaign). */
  block(id: string, campaign: boolean): void
  /** The address of the word's record on a tab (`?word=&tab=` over the page's own). */
  href(id: string, tab: WordTab): string
  /** Why every verb is held for this person (wasteModel.ts writeHeld), or null. */
  noWrite: string | null
}
export interface WordCellContext { readonly current: WordCellHandlers }
type Cell = ICellRendererParams<WordGridRow> & { context?: WordCellContext }

const G = { size: 13, strokeWidth: 2.25, 'aria-hidden': true as const }

/** The word mark (a word, not a whole search term). */
export const WordMark = ({ terms }: { terms: number }) => (
  <Mark label={`A word ${plural(terms, 'search term')} hold`} tone="muted"><WholeWord {...G} className="nds-cell-glyph" /></Mark>
)

function WordView({ row, phone }: { row: WordGridRow; phone?: boolean }) {
  return (
    <span className={styles.term}>
      <span className={styles.termLine}>
        <WordMark terms={row.terms} />
        {/* Phone: the word wraps to two lines in its 150 px. */}
        <span className={phone ? styles.termWrap : styles.termText} title={row.word}>{row.word}</span>
      </span>
    </span>
  )
}
const WordCell = memo(function WordCell({ data }: Cell) { return data ? <WordView row={data} /> : null })
const PhoneWordCell = memo(function PhoneWordCell({ data }: Cell) { return data ? <WordView row={data} phone /> : null })

/**
 * A count that names a set: a link (the page's link cell, as the Where and Product links) to the word's record on that
 * tab — its own address, so it opens in a new tab too; a plain click opens it here, as a row's click does.
 */
function SetLink({ label, title, id, tab, context, end = false }: { label: string; title: string; id: string; tab: WordTab; context?: WordCellContext; end?: boolean }) {
  const open = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    e.preventDefault()
    context?.current.open(id, tab)
  }
  return (
    <span className={end ? own.cellEnd : styles.cellFill} onClickCapture={keepFromGrid}>
      <Link href={context?.current.href(id, tab) ?? '#'} className={`nds-entitylink ${styles.ellipsis}`} title={title} aria-label={title} onClick={open}>{label}</Link>
    </span>
  )
}

const TermsCell = memo(function TermsCell({ data, context }: Cell) {
  if (!data) return null
  const title = `${plural(data.terms, 'search term')} hold "${data.word}"${data.sold ? ` · ${data.sold} sold` : ''} — show them`
  return <SetLink label={String(data.terms)} title={title} id={data.id} tab="terms" context={context} end />
})

const PlacesCell = memo(function PlacesCell({ data, context }: Cell) {
  if (!data) return null
  const p = data.places
  const title = `${placesWords(data)}${p.blocked ? ` · blocked in ${p.blocked}` : ''}${p.open ? ` · lands in ${p.open}` : ''} — show where`
  return <SetLink label={plural(p.adGroups, 'ad group')} title={title} id={data.id} tab="where" context={context} />
})

const ProductsCell = memo(function ProductsCell({ data, context }: Cell) {
  if (!data) return null
  if (data.product) return <TwoLineLink name={data.product.name} href={data.product.href} />
  if (data.products > 1) return <SetLink label={productsWords(data)} title={`Its terms ran for ${plural(data.products, 'product')}, each judged by its own bar — show them`} id={data.id} tab="overview" context={context} />
  return <span className="nds-cell-muted">—</span>
})

const SpendCell = memo(function SpendCell({ data }: Cell) {
  if (!data) return null
  return <span title={data.stockOutDays ? `${plural(data.stockOutDays, 'day')} out of stock left out` : undefined}>{moneyOr(data.d.spendCents, data.currency)}</span>
})

/** D6 — the state as one chip (a word in a tone, its mark); under it, the word that covers a 2-word piece. */
const StateCell = memo(function StateCell({ data }: Cell) {
  if (!data) return null
  const sub = wordStateSub(data)
  return (
    <span className={own.stateCell}>
      <StateChip chip={wordStateChip(data)} />
      {sub && (
        <span className={`nds-cell-sub ${own.stateSub}`} title={sub.title}>
          <Layers size={12} strokeWidth={2.25} aria-hidden className="nds-cell-glyph" />
          <span className={styles.ellipsis}>{sub.word}</span>
          <span className="nds-vh">: blocking that word blocks this one</span>
        </span>
      )}
    </span>
  )
})

/** The verb as the DS row button, secondary (D6), held with the server's reason when it lands nowhere. */
const verbOf = (v: WordVerbView): RowVerb<WordGridRow> => ({
  id: 'block-word',
  label: v.short,
  tone: 'default',
  ariaLabel: () => v.sentence,
  disabled: () => v.held,
})

const DESC_FIRST = { sortingOrder: ['desc', 'asc', null] as Array<'desc' | 'asc' | null> }
const numeric = { type: 'rightAligned', headerClass: 'nds-ag-head-num', ...DESC_FIRST } as const
const H = { suppressHeaderMenuButton: true } as const
const num = ['nds-ag-cell', 'nds-ag-num']
/** The server orders the words: a header's sort is sent as `?sort=`; the grid never re-sorts a page. */
const serverSort = { comparator: () => 0 }
const moneyOf = (p: { value: unknown; data?: { currency: string } }) => moneyOr(p.value as number | null, p.data?.currency ?? 'EUR')

export type ColumnSpec = { key: string; label: string; locked?: boolean; hidden?: boolean }

export const WORD_COLUMN_SPECS: ReadonlyArray<ColumnSpec> = [
  { key: 'word', label: 'Word', locked: true },
  { key: 'terms', label: 'Terms' },
  { key: 'spend', label: 'Spend' },
  { key: 'clicks', label: 'Clicks' },
  { key: 'orders', label: 'Orders' },
  { key: 'places', label: 'Places' },
  { key: 'products', label: 'Product' },
  { key: 'state', label: 'State' },
  { key: 'impressions', label: 'Impressions', hidden: true },
  { key: 'acos', label: 'ACoS', hidden: true },
  { key: 'cpc', label: 'CPC', hidden: true },
  { key: 'sold', label: 'Sold', hidden: true },
  { key: 'stockOut', label: 'Out of stock', hidden: true },
]

/** Cells that answer Enter themselves (a link or a button): Enter there never opens the record. */
export const WORD_OWN_KEY_COLUMNS = new Set(['terms', 'places', 'products', 'actions'])

/**
 * The board's widths (D14): Word 220 · Terms 84 · Spend 100 · Clicks 84 · Orders 84 · Places 130 · Product ≥ 140 · State
 * 150 · the verb fits its buttons. Phone (D16): the same columns, Word 150 and two lines, the verb last and unpinned.
 */
export function wordColumns(phone: boolean, handlers: WordCellContext): ColDef<WordGridRow>[] {
  const L = Object.fromEntries(WORD_COLUMN_SPECS.map((c) => [c.key, c.label])) as Record<string, string>
  const hidden = new Set(WORD_COLUMN_SPECS.filter((c) => c.hidden).map((c) => c.key))
  const keys = { suppressKeyboardEvent: ownerKeys as ColDef<WordGridRow>['suppressKeyboardEvent'] }
  const cols: ColDef<WordGridRow>[] = [
    { colId: 'word', headerName: L.word, valueGetter: (p) => p.data?.word ?? '', cellRenderer: phone ? PhoneWordCell : WordCell, pinned: 'left', width: phone ? 150 : 220, cellClass: 'nds-ag-cell', ...serverSort },
    { colId: 'terms', headerName: L.terms, valueGetter: (p) => p.data?.terms ?? null, cellRenderer: TermsCell, width: 84, cellClass: num, ...numeric, ...serverSort, ...keys, headerTooltip: 'Search terms that hold the word (its words next to each other). Enter: show them' },
    { colId: 'spend', headerName: L.spend, valueGetter: (p) => p.data?.d.spendCents ?? null, valueFormatter: moneyOf, cellRenderer: SpendCell, width: 100, cellClass: num, ...numeric, ...serverSort, headerTooltip: 'Its terms\' spend in the window, out-of-stock days left out' },
    { ...integerColumn<WordGridRow>('d.clicks'), colId: 'clicks', headerName: L.clicks, width: 84, ...DESC_FIRST, ...serverSort },
    { ...integerColumn<WordGridRow>('d.orders'), colId: 'orders', headerName: L.orders, width: 84, ...DESC_FIRST, ...serverSort, headerTooltip: 'Orders up to today: a late order can only save a word' },
    { colId: 'places', headerName: L.places, valueGetter: (p) => p.data?.places.adGroups ?? null, cellRenderer: PlacesCell, width: 130, cellClass: 'nds-ag-cell', ...DESC_FIRST, ...serverSort, ...keys, headerTooltip: 'Ad groups where its terms spent. Enter: show where' },
    { colId: 'products', headerName: L.products, valueGetter: (p) => (p.data ? productsWords(p.data) : ''), cellRenderer: ProductsCell, ...(phone ? { width: 140 } : { flex: 1, minWidth: 140 }), cellClass: 'nds-ag-cell', ...serverSort, ...keys },
    { colId: 'state', headerName: L.state, valueGetter: (p) => (p.data ? wordStateWord(p.data.state) : ''), cellRenderer: StateCell, width: 150, cellClass: 'nds-ag-cell', ...serverSort },
    { ...integerColumn<WordGridRow>('d.impressions'), colId: 'impressions', headerName: L.impressions, width: 116, sortable: false },
    { colId: 'acos', headerName: L.acos, valueGetter: (p) => p.data?.d.acosPct ?? null, valueFormatter: (p) => acosText(p.value as number | null), width: 92, cellClass: num, ...numeric, sortable: false },
    { colId: 'cpc', headerName: L.cpc, valueGetter: (p) => p.data?.d.cpcCents ?? null, valueFormatter: moneyOf, width: 88, cellClass: num, ...numeric, sortable: false },
    { ...integerColumn<WordGridRow>('sold'), colId: 'sold', headerName: L.sold, width: 80, sortable: false, headerTooltip: 'Terms holding it that sold in their window' },
    { ...integerColumn<WordGridRow>('stockOutDays'), colId: 'stockOut', headerName: L.stockOut, width: 120, sortable: false, headerTooltip: 'Days left out: the product was out of stock' },
    {
      // A phone keeps the verb as the last column (two pinned columns leave no room).
      ...actionsColumn<WordGridRow>({ primary: (row) => [verbOf(wordVerb(row))] as never, prefsLabel: 'Action', pinned: !phone }),
      suppressKeyboardEvent: verbKeys as ColDef<WordGridRow>['suppressKeyboardEvent'],
    },
  ]
  return cols.map((c) => {
    // Hidden at creation only (`initialHide`): Customise and a saved layout own it after that.
    const col = { ...c, ...H, ...(hidden.has(c.colId as string) ? { initialHide: true } : {}) }
    if (c.colId !== 'actions') return col
    const params = (c.cellRendererParams ?? {}) as Record<string, unknown>
    return {
      ...col,
      cellRendererParams: {
        ...params,
        // Held for a person who may not change ads, with the page's one reason (wasteModel.ts writeHeld).
        primary: (row: WordGridRow) => {
          const v = wordVerb(row)
          return [{ ...verbOf(v), disabled: () => handlers.current.noWrite ?? v.held, onClick: (d: WordGridRow) => handlers.current.block(d.id, false) }]
        },
        // The ⋯: the whole campaign, then Open record (it never needs a write).
        items: (row: WordGridRow): MenuItemDef[] => {
          const v = wordVerb(row, 'campaign')
          const held = handlers.current.noWrite ?? v.held
          return [
            { id: 'block-campaign', label: v.label, title: v.sentence, ...(held ? { disabled: true, description: held } : { onSelect: () => handlers.current.block(row.id, true) }) },
            { id: 'sep-record', separator: true },
            { id: 'record', label: 'Open record', onSelect: () => handlers.current.open(row.id, 'overview') },
          ]
        },
        menuLabel: (row: WordGridRow) => `More for ${row.word}`,
      },
    }
  }) as ColDef<WordGridRow>[]
}
