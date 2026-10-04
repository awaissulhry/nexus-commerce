'use client'

/**
 * Sheet publish parity, build shape v2 (Owner 2026-10-04), phase P9 — the SHARED scope's **Status** column: one cell per
 * product row that summarises every market of that product, and a choice that is written to every market where it is
 * allowed (the Owner's option B).
 *
 *  - The cell: "Active" when every market agrees; "Active in 5 of 7" or "Mixed" when they differ (`sellingSummaryOf`).
 *    A value waiting for Publish shows as the channel cell does — a clock pill with the live words beside it:
 *    "[clock Inactive] now Active", "[clock Inactive on 3 of 7] now Active in 5 of 7", "[clock 3 waiting] now Mixed".
 *    The tooltip lists each market, its state and what waits.
 *  - The editor (DS `SelectPanelEditor`): Active · Inactive (· Ended when a market's channel can end: eBay, Shopify),
 *    each with how many markets allow it ("5 of 7 markets. 2 not allowed: …"); a value no market allows stays in the
 *    list, held, with the reason. Ended needs `products.delete`.
 *  - Choosing a value STAGES one change per listing of the product in the sheet's operation fence; the sheet sends one
 *    write per value and ONE toast that names the markets that refused and why (`sharedOperationToast`). Delete /
 *    Backspace clears what waits on every market. Nothing is sent to a channel here: Publish does.
 *
 * Like the channel sheet's Status column (`../channel/statusColumn.tsx`, P8): a system column (`managedBy: 'progress'`,
 * listed in Customise, never a write field), the value lives in `usePublishActions`, `valueSetter` never writes the row.
 *
 * New listings (Owner 2026-10-04): a market where the product is not on the channel yet (Draft) is a NEW listing; the
 * cell counts them ("Active in 5 of 7 · 2 new"), a product new everywhere shows its choice ("[Inactive] 2 new"), and the
 * editor adds Not listed (each counted: "2 of 7 markets"). A Shared-scope write never starts a listing: markets with no
 * listing at all are left out and the toast says so (the server's `leftOut`).
 *
 * Delete and relist (simplify, Owner 2026-10-04): a market Nexus deleted reads Not listed (counted "1 deleted"); its line
 * says why. Listing it again is a choice made in that market's own sheet, so here it takes no Status (the editor and
 * Action ▾ count it as not allowed, with the server's words: `sharedDeletedRefusal`). A product deleted on every market
 * is read-only here.
 */
import { Clock, Lock } from 'lucide-react'
import { memo } from 'react'
import { type NewListingTarget, type StatusTarget } from '@nexus/shared/listing-actions'
import type { PublishActionCell } from '@nexus/shared/publish-actions'
import {
  SelectPanelEditor, SellingStatePill, composeCellTooltip, newListingPill, roundTripClassRules, saveNote, waitingSetPhrase,
  STATUS_REFUSED_FALLBACK, STATUS_TARGET_TONE, STATUS_TARGET_WORD,
  type CellSaveTracker, type ColDef, type ICellRendererParams, type SelectPanelOption, type SellingPillMeta,
} from '@/design-system/grid'
import { Pill, Skeleton } from '@/design-system/primitives'
import type { Tone } from '@/design-system/primitives/tone'
import { isClearKey } from '../sheetReset'
import type { PublishCellInput } from '../usePublishActions'
import { ENDED_NEEDS_DELETE, STATUS_COLUMN, currentStatusTarget, parseStatusInput, samePublishCellValue, statusEditorChoices, type PublishCellReadState } from '../channel/statusColumn'
import { freshWords, marketLabel, marketLine, sellingSummaryOf, statusWaitingOf } from '../../SellingSummary'

export { STATUS_COLUMN as SHARED_STATUS_COLUMN }
export const SHARED_STATUS_LABEL = 'Status'
/** "[clock Inactive on 3 of 7] now Active in 5 of 7" — the pill, plus the start of the live words. */
export const SHARED_STATUS_WIDTH = 230
export const SHARED_STATUS_TIP = 'Where each product sells: Active, Inactive, Not listed or Ended (eBay, Shopify) on every market it is listed on ("Active in 5 of 7", or Mixed, when they differ). Choose a value (Enter on a cell, or Action ▾ for the ticked rows) to set it on every market where it is allowed; Publish sends the changes. Hover a cell to see each market.'
export const SHARED_NOT_LISTED = 'Not listed on any market yet. Publish creates the listings.'
export const SHARED_ONLY_DRAFTS = 'Not on any channel yet: Publish creates these listings.'
export const SHARED_MIXED_REFUSED = 'These markets differ, so there is no one Status to copy. Choose Active, Inactive or Ended'
/** A product Nexus deleted on every market it was listed on. */
export const SHARED_ALL_DELETED = 'Deleted on every market. To list them again, set their Status to Active in each market\'s sheet and Publish.'

/**
 * Why the shared scope sets no Status or Action on a market Nexus deleted — the server's own words for a refused fan-out
 * (publish-action.service.ts `SHARED_DELETED`): listing it again is a choice made in that market's own sheet.
 */
export const sharedDeletedRefusal = (cell: Pick<PublishActionCell, 'deleted' | 'channel' | 'marketplace' | 'aliasKey'>) => {
  const where = cell.deleted?.where ?? marketLabel(cell)
  return `Deleted on ${where}. To list it again, set its Status in the ${where} sheet.`
}

/** A market as the shared scope may change it: on a deleted market every Status and Action is refused (`sharedDeletedRefusal`). */
export function sharedCell(cell: PublishActionCell): PublishActionCell {
  if (!cell.deleted) return cell
  const reason = sharedDeletedRefusal(cell)
  return { ...cell, sendOptions: cell.sendOptions.map(option => ({ ...option, offered: false, reason, warning: null })),
    statusOptions: cell.statusOptions.map(option => ({ ...option, offered: false, reason, warning: null })) }
}
/** A Status a new market cannot take (Ended), or Not listed on a market where the product is on the channel. */
export const SHARED_NEW_ROW_STATUS = 'Not on the channel yet: choose Active, Inactive or Not listed.'
export const SHARED_NOT_LISTED_ON_CHANNEL = 'On the channel already: Not listed applies only before the first Publish.'

/** The column as a member of the sheet's column model (Customise, saved views). Never a write field. */
export function sharedStatusSheetColumn<T>(): T {
  return {
    key: STATUS_COLUMN, writeField: '', label: SHARED_STATUS_LABEL, group: 'Publish', groupKey: 'publish', kind: 'text',
    storage: 'column', scope: 'global', requiredBy: [], editable: false, formulaWritable: false, width: SHARED_STATUS_WIDTH,
    defaultVisible: true, managedBy: 'progress', helpText: SHARED_STATUS_TIP,
  } as unknown as T
}

// ── The cell ─────────────────────────────────────────────────────────────────────────────────────

/** One shared cell (Status or Action) as the grid holds it. `undefined` = not read yet (a skeleton). */
export interface SharedCellValue {
  kind: 'shared-status' | 'shared-action'
  /** The pill, or null for the quiet default ("Partial update"). */
  pill: SellingPillMeta | null
  /** The quiet text when there is no pill. */
  quiet: string | null
  /** Small text beside the pill ("now Active in 5 of 7"). */
  aside: string | null
  /** The value every market agrees on — what the editor opens on and what a fill copies — or null. */
  common: string | null
  /** The whole screen-reader sentence. */
  ariaLabel: string
  /** The tooltip: the summary, then one line per market. */
  tooltip: string
  lockedReason: string | null
  /** The product's listings (each has a market). */
  total: number
  /** Action: no market is on the channel — the cell reads Full update (sent whole) and holds no value: never copied. */
  notOnChannel?: boolean
}

const sentence = (text: string) => { const t = text.trim(); return !t ? '' : /[.!?]$/.test(t) ? t : `${t}.` }
const n = (count: number) => count.toLocaleString('en')
const worst = (targets: Iterable<StatusTarget>): Tone => {
  const all = new Set(targets)
  return all.has('ended') ? 'danger' : all.has('inactive') ? 'warning' : 'info'
}

/** One shared Status cell from the product's listings. */
export function sharedStatusValue(cells: readonly PublishActionCell[], read: PublishCellReadState, now: number = Date.now()): SharedCellValue | undefined {
  if (!read.loaded) return undefined
  const live = sellingSummaryOf(cells)
  const lines = cells.map(cell => marketLine(cell, now))
  const allDeleted = cells.length > 0 && cells.every(cell => cell.deleted)
  // New listings: markets not on the channel yet choose what Publish creates — the product stays editable.
  const lockedReason = read.failed && !cells.length ? 'The selling state could not be read. Reload the sheet to try again.'
    : read.lockedReason ?? (!cells.length ? SHARED_NOT_LISTED
      : allDeleted ? (cells.length === 1 ? sharedDeletedRefusal(cells[0]) : SHARED_ALL_DELETED)
        : !live.onChannel && !live.fresh && !live.deleted ? SHARED_ONLY_DRAFTS : null)
  const livePill: SellingPillMeta = { label: live.word, tone: live.tone, glyph: 'dot' }
  const common = commonStatusTarget(cells)
  const many = live.total > 1 ? ` on ${n(live.total)} markets` : ''
  const fresh = freshWords(live)
  const freshSentence = live.fresh ? ` ${live.fresh === 1 ? '1 market is a new listing' : `${n(live.fresh)} markets are new listings`}: Publish creates ${live.fresh === 1 ? 'it' : 'them'} as each Status says.` : ''
  // A product new on every market: its choice is the cell ("[Inactive] 2 new"), not the drafts' state.
  if (!lockedReason && !live.onChannel && live.fresh === cells.length) {
    const creates = cells.map(cell => cell.create!)
    const target = creates.every(c => c.target === creates[0].target) ? creates[0].target : null
    const own = creates.every(c => c.source === 'own')
    const pill: SellingPillMeta = target ? newListingPill({ target, source: own ? 'own' : 'default' }) : { label: 'Mixed', tone: 'neutral', glyph: 'none' }
    const words = target ? `New listing${cells.length > 1 ? 's' : ''}: ${STATUS_TARGET_WORD[target]}${cells.length > 1 ? ` on every market (${n(cells.length)})` : ''}.` : `New listings: ${[...new Set(creates.map(c => STATUS_TARGET_WORD[c.target]))].join(', ')}.`
    return { kind: 'shared-status', pill, quiet: null, aside: fresh, common, lockedReason: null, total: live.total,
      ariaLabel: `Status: ${words}`, tooltip: composeCellTooltip(words, lines.join('\n')) }
  }
  const liveSentence = `${live.word}${live.uniform && live.total > 1 ? many : ''}.`
  if (lockedReason) {
    return { kind: 'shared-status', pill: livePill, quiet: null, aside: null, common, lockedReason, total: live.total,
      ariaLabel: `Status: ${liveSentence} ${sentence(lockedReason)}`, tooltip: composeCellTooltip(sentence(lockedReason), lines.join('\n')) }
  }
  const waiting = statusWaitingOf(cells)
  if (!waiting) {
    return { kind: 'shared-status', pill: livePill, quiet: null, aside: fresh, common, lockedReason: null, total: live.total,
      ariaLabel: `Status: ${liveSentence}${freshSentence}`, tooltip: composeCellTooltip(`${liveSentence}${freshSentence}`, lines.join('\n')) }
  }
  const by = waiting.by ? waitingSetPhrase(waiting.by, now) : ''
  const word = waiting.value ? STATUS_TARGET_WORD[waiting.value] : null
  const label = word ? (waiting.count === waiting.total ? word : `${word} on ${n(waiting.count)} of ${n(waiting.total)}`) : `${n(waiting.count)} waiting`
  const waits = word
    ? `${word} waits for Publish on ${waiting.count === waiting.total ? (waiting.total === 1 ? 'this market' : `every market (${n(waiting.total)})`) : `${n(waiting.count)} of ${n(waiting.total)} markets`}${by ? `, ${by}` : ''}.`
    : `${n(waiting.count)} Status changes wait for Publish: ${[...waiting.byValue].map(([t, c]) => `${STATUS_TARGET_WORD[t]} on ${n(c)}`).join(', ')}${by ? `, ${by}` : ''}.`
  return {
    kind: 'shared-status', pill: { label, tone: waiting.value ? STATUS_TARGET_TONE[waiting.value] : worst(waiting.byValue.keys()), glyph: 'clock' },
    quiet: null, aside: [`now ${live.word}`, fresh].filter(Boolean).join(' · '), common, lockedReason: null, total: live.total,
    ariaLabel: `Status: ${liveSentence} ${waits}${freshSentence}`, tooltip: composeCellTooltip(`${waits} Now ${live.word} on the channels.${freshSentence}`, lines.join('\n')),
  }
}

/** The Status every market agrees on — its waiting value, else its live state — or null when they differ. */
export function commonStatusTarget(cells: readonly PublishActionCell[]): StatusTarget | null {
  if (!cells.length) return null
  const first = currentStatusTarget(cells[0])
  return first && cells.every(cell => currentStatusTarget(cell) === first) ? first : null
}

/** "[pill] aside" — the shared Status and Action cells' content without AG Grid (also the record drawer's). */
export function SharedSummaryView({ value }: { value: SharedCellValue | undefined }) {
  if (value === undefined) {
    return (
      <span className="nds-selling-cell is-loading">
        <Skeleton width={96} height={16} radius="var(--nds-radius-pill)" />
        <span className="nds-vh">Loading the selling state.</span>
      </span>
    )
  }
  const kind = value.lockedReason ? 'locked' : value.pill?.glyph === 'clock' ? 'waiting' : value.pill ? 'live' : 'default'
  return (
    <span className={`${value.kind === 'shared-action' ? 'nds-action-cell' : 'nds-selling-cell'} is-${kind}`}>
      <span className="nds-selling-visual" aria-hidden="true">
        {value.pill
          ? value.pill.glyph === 'clock'
            ? <Pill tone={value.pill.tone} className="nds-selling-pill" icon={<Clock size={11} strokeWidth={2.5} aria-hidden="true" />}>{value.pill.label}</Pill>
            : <SellingStatePill pill={value.pill} />
          : <span className="nds-action-quiet">{value.quiet}</span>}
        {value.aside && <span className="nds-selling-aside">{value.aside}</span>}
        {value.lockedReason && <Lock size={11} strokeWidth={2.25} className="nds-selling-lock" aria-hidden="true" />}
      </span>
      <span className="nds-vh">{value.ariaLabel}</span>
    </span>
  )
}

export const SharedSummaryCell = memo(function SharedSummaryCell(p: ICellRendererParams) {
  if (!p.data) return null
  return <SharedSummaryView value={p.value as SharedCellValue | undefined} />
})

/** The cell's text for copy, export and search. */
export function sharedCellText(value: SharedCellValue | undefined): string {
  return value ? value.pill?.label ?? value.quiet ?? '' : ''
}

// ── The editor ───────────────────────────────────────────────────────────────────────────────────

const topReason = (reasons: Map<string, number>) => [...reasons.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? STATUS_REFUSED_FALLBACK

/**
 * The editor's options for a product with several markets: every Status, with how many of its markets allow it; a value
 * no market allows is HELD with the most common reason. One market: exactly the channel cell's options.
 */
export function sharedStatusEditorOptions(input: readonly PublishActionCell[], canDelete: boolean): SelectPanelOption[] {
  // A market Nexus deleted takes no Status from here (its own sheet lists it again): held, with the server's words.
  const cells = input.map(sharedCell)
  if (cells.length === 1) return statusEditorChoices(cells[0], canDelete)
  const total = cells.length
  // New listings: Not listed is offered when a market is not on the channel; Ended only where a channel can end.
  const targets: StatusTarget[] = ['active', 'inactive', ...(cells.some(cell => cell.create) ? ['not_listed' as const] : []),
    ...(cells.some(cell => cell.statusOptions.some(o => o.target === 'ended')) ? ['ended' as const] : [])]
  return targets.map(target => {
    const label = STATUS_TARGET_WORD[target]
    let allowed = 0
    let already = 0
    let waitingHere = 0
    const reasons = new Map<string, number>()
    for (const cell of cells) {
      const option = cell.statusOptions.find(o => o.target === target)
      const roleRefused = target === 'ended' && !!option?.offered && !!option.action && !canDelete
      if (option?.offered && !roleRefused) {
        allowed += 1
        // A new market holds its choice already; a listed one is already there when the target needs no action.
        if (cell.create ? cell.create.target === (target as NewListingTarget) : !option.action) already += 1
      } else {
        const missing = !option ? (cell.create ? SHARED_NEW_ROW_STATUS : target === 'not_listed' ? SHARED_NOT_LISTED_ON_CHANNEL : null) : null
        const why = roleRefused ? ENDED_NEEDS_DELETE : option?.reason?.trim() || missing || STATUS_REFUSED_FALLBACK
        reasons.set(why, (reasons.get(why) ?? 0) + 1)
      }
      if (cell.status.target === target && !cell.status.noLongerApplies) waitingHere += 1
    }
    if (!allowed) { const why = topReason(reasons); return { value: target, label, heldReason: why, note: why } }
    const notes = [
      allowed === total ? `Every market (${n(total)}).` : `${n(allowed)} of ${n(total)} markets. ${n(total - allowed)} not allowed: ${sentence(topReason(reasons))}`,
      waitingHere ? `Waiting for Publish on ${waitingHere === total ? 'every market' : `${n(waitingHere)} of them`}.`
        : already === total ? 'Now on every market.' : null,
    ].filter(Boolean)
    return { value: target, label, note: notes.join(' ') }
  })
}

/**
 * What a shared Status cell received — its editor ('inactive'), a paste ("Pause"), a fill (another shared cell: its
 * common value; "Mixed" cannot be copied) or Delete (null: clear what waits) — as a change, or the reason it is not one.
 */
export function parseSharedStatusInput(raw: unknown): PublishCellInput {
  if (raw && typeof raw === 'object' && (raw as { kind?: unknown }).kind === 'shared-status') {
    const common = (raw as SharedCellValue).common as StatusTarget | null
    return common ? { change: { column: 'status', target: common } } : { refused: SHARED_MIXED_REFUSED }
  }
  if (raw && typeof raw === 'object' && (raw as { kind?: unknown }).kind === 'shared-action') return { refused: 'An Action is not a Status: use the Action column' }
  return parseStatusInput(raw)
}

// ── The column ───────────────────────────────────────────────────────────────────────────────────

export interface SharedColumnInput<Row> {
  /** The product's listings (every market), read through refs so a new read repaints without rebuilding the column. */
  cells: (row: Row) => readonly PublishActionCell[]
  read: () => PublishCellReadState
  onInput: (row: Row, input: PublishCellInput) => void
  canDelete: () => boolean
  tracker: CellSaveTracker
  rowIdOf: (row: Row) => string
}

export function sharedStatusColumn<Row>(input: SharedColumnInput<Row>): ColDef<Row> {
  const valueOf = (row: Row) => sharedStatusValue(input.cells(row), input.read())
  return {
    colId: STATUS_COLUMN,
    headerName: SHARED_STATUS_LABEL,
    headerTooltip: SHARED_STATUS_TIP,
    width: SHARED_STATUS_WIDTH,
    minWidth: 170,
    sortable: false,
    cellClass: 'nds-ag-cell',
    cellClassRules: roundTripClassRules<Row>(input.tracker, input.rowIdOf),
    valueGetter: p => (p.data ? valueOf(p.data) : undefined),
    equals: samePublishCellValue,
    valueFormatter: p => sharedCellText(p.value as SharedCellValue | undefined),
    // Never writes the row: the value is staged and sent by the sheet.
    valueSetter: p => { if (p.data) input.onInput(p.data, parseSharedStatusInput(p.newValue)); return false },
    editable: p => { const v = p.data ? valueOf(p.data) : undefined; return !!v && !v.lockedReason },
    cellEditor: SelectPanelEditor,
    cellEditorPopup: true,
    cellEditorPopupPosition: 'under',
    cellEditorParams: (p: { data?: Row }) => {
      const cells = p.data ? input.cells(p.data) : []
      return { value: commonStatusTarget(cells), options: sharedStatusEditorOptions(cells, input.canDelete()) }
    },
    cellRenderer: SharedSummaryCell,
    tooltipValueGetter: p => composeCellTooltip(
      saveNote(p.data ? input.tracker.get(input.rowIdOf(p.data), STATUS_COLUMN) : undefined),
      (p.value as SharedCellValue | undefined)?.tooltip ?? 'Loading the selling state.',
    ),
    suppressKeyboardEvent: p => isClearKey(p.event, p.editing),
  }
}
