'use client'

/**
 * Sheet publish parity, build shape v2 (Owner 2026-10-04), phase P9 — the SHARED scope's **Action** column (how Publish
 * sends each market of a product: Partial update, the quiet default · Full update · Delete), the selection bar's
 * **Action ▾** for the ticked products (next to "Delete child…"), the typed confirmation of a shared Delete, and the one
 * toast of a shared operation.
 *
 *  - The cell summarises the product's markets: quiet "Partial update" when nothing waits; "[clock Full update]" when
 *    every market waits for it; "[clock Delete on 2 of 7]" or "[clock 3 waiting]" otherwise. The tooltip lists each market.
 *  - A change is written to every market of the product where it is allowed (the Owner's option B); the toast names the
 *    markets that refused and why ("Full update set on 5 listings. 2 not allowed: GALE-S · eBay · IT (…)").
 *  - Delete is set only after a confirmation that LISTS every listing it would remove and asks for the SKU typed (for
 *    several products: the number of listings). Setting it sends nothing: Publish removes the listings, and asks again.
 *  - Action ▾ (`sharedActionMenuEntries`) offers the channel menu's groups — Status: Active, Inactive (Not listed, Ended
 *    where they apply) · Send as: Partial update, Full update, Delete — counted across every market of the ticked
 *    products. It only fills the cells.
 *  - A market where the product is not on the channel (simplify, Owner 2026-10-04: never sent, no listing, or deleted by
 *    Nexus) reads Full update — a create is always sent whole (counted in the cell: "Partial update · 2 new"; a product
 *    on no channel reads "[Full update]"). Nothing is stored for it: Partial update and Delete are refused there with the
 *    server's reason, and its Full update is never copied.
 *  - Delete and relist: a market Nexus deleted is listed again from that market's own sheet (its Status), so here every
 *    Status and Action on it is refused with the server's own words ("Deleted on Amazon · IT. To list it again, set its
 *    Status in the Amazon · IT sheet.") — in the editor, Action ▾ and the toast. The cell names such markets ("1
 *    deleted", "1 lists again").
 */
import { SEND_MODES, type PublishActionCell, type SendMode } from '@nexus/shared/publish-actions'
import {
  SelectPanelEditor, composeCellTooltip, roundTripClassRules, saveNote, waitingSetPhrase,
  NEW_ROW_SENT_WHOLE, SEND_MODE_GROUP, SEND_MODE_REFUSED_FALLBACK, SEND_MODE_TONE, SEND_MODE_WORD, sendModeDefaultNote,
  type ColDef, type SelectPanelOption,
} from '@/design-system/grid'
import type { ActionImpact } from '@/design-system/grid/actions/registry'
import { isClearKey } from '../sheetReset'
import { SKIP_CELL, operationToast, type PublishActionWriteOutcome, type PublishCellInput } from '../usePublishActions'
import { ACTION_COLUMN, DELETE_NEEDS_DELETE, actionEditorChoices, actionPartialNote, parseSendInput } from '../channel/actionColumn'
import { actionMenuEntries, type ActionMenuEntry, type ActionMenuRow } from '../channel/channelActions'
import { samePublishCellValue, type PublishCellReadState } from '../channel/statusColumn'
import { marketLabel, sendWaitingOf } from '../../SellingSummary'
import { SharedSummaryCell, sharedCell, sharedCellText, sharedDeletedRefusal, type SharedCellValue, type SharedColumnInput } from './sharedStatusColumn'

export { sharedDeletedRefusal }

export { ACTION_COLUMN as SHARED_ACTION_COLUMN }
export const SHARED_ACTION_LABEL = 'Action'
/** "[clock Delete on 2 of 7]" — the widest content, plus padding. */
export const SHARED_ACTION_WIDTH = 170
export const SHARED_ACTION_TIP = 'What Publish sends for each product on every market it is listed on: Partial update (the default: only the fields you changed), Full update (every field Nexus manages again) or Delete (removes the listings from the channels). A market not on the channel reads Full update: a new listing is always sent whole. A choice is set on every market where it is allowed. Nothing is sent until you press Publish.'
export const SHARED_ACTION_NOT_LISTED = 'Not listed on any market yet: Publish creates the listings with every field.'
export const SHARED_ACTION_MIXED_REFUSED = 'These markets differ, so there is no one Action to copy. Choose Partial update, Full update or Delete'

export function sharedActionSheetColumn<T>(): T {
  return {
    key: ACTION_COLUMN, writeField: '', label: SHARED_ACTION_LABEL, group: 'Publish', groupKey: 'publish', kind: 'text',
    storage: 'column', scope: 'global', requiredBy: [], editable: false, formulaWritable: false, width: SHARED_ACTION_WIDTH,
    defaultVisible: true, managedBy: 'progress', helpText: SHARED_ACTION_TIP,
  } as unknown as T
}

const sentence = (text: string) => { const t = text.trim(); return !t ? '' : /[.!?]$/.test(t) ? t : `${t}.` }
const n = (count: number) => count.toLocaleString('en')
const plural = (count: number, one: string, many: string) => `${n(count)} ${count === 1 ? one : many}`
const QUIET_HINT = 'Publish sends only the fields you changed.'

/**
 * What Partial update does across a product's markets ON the channel, where some market's Partial update carries the
 * channel scope's own note (D5, D13: a product already on Shopify — `SHOPIFY_EXISTING_NOT_YET` —, Etsy —
 * `ETSY_FIELDS_NOT_SENT`): the note alone when every market shares it; otherwise each note after the markets it applies
 * to, then "Other markets: Publish sends only the fields you changed.". Null when no market has a note (the usual hint).
 */
export function sharedPartialHint(listed: readonly PublishActionCell[]): string | null {
  const byNote = new Map<string, string[]>()
  let plain = 0
  for (const cell of listed) {
    const note = actionPartialNote(cell)
    if (note) byNote.set(note, [...(byNote.get(note) ?? []), marketLabel(cell)])
    else plain += 1
  }
  if (!byNote.size) return null
  if (!plain && byNote.size === 1) return [...byNote.keys()][0]
  return [...[...byNote].map(([note, markets]) => `${markets.join(', ')}: ${sentence(note)}`), plain ? `Other markets: ${QUIET_HINT}` : null].filter(Boolean).join(' ')
}

// ── Markets not on the channel (new, or deleted by Nexus) ─────────────────────────────────────────

/** A market as the shared scope may change it: on a deleted market every Action is refused with `sharedDeletedRefusal`. */
export const sharedSendCell = (cell: PublishActionCell): PublishActionCell => sharedCell(cell)

/** "1 deleted · 1 lists again" — the deleted markets of a product, or null. */
function deletedWords(cells: readonly PublishActionCell[]): string | null {
  const off = cells.filter(cell => cell.deleted && cell.create?.target === 'not_listed').length
  const again = cells.filter(cell => cell.deleted && cell.create && cell.create.target !== 'not_listed').length
  return [off ? `${n(off)} deleted` : null, again ? `${n(again)} lists again` : null].filter(Boolean).join(' · ') || null
}

/** One market's Action as a tooltip line. */
function sendLine(cell: PublishActionCell, now: number): string {
  if (cell.create) {
    if (cell.create.target === 'not_listed') return `${marketLabel(cell)}: ${SEND_MODE_WORD.full}, but its Status is Not listed: Publish leaves it out.${cell.deleted ? ` ${sentence(cell.deleted.sentence)}` : ''}`
    return `${marketLabel(cell)}: ${SEND_MODE_WORD.full} (${cell.deleted ? 'listed again, whole' : 'a new listing, sent whole'}).`
  }
  const word = SEND_MODE_WORD[cell.send.mode]
  if (cell.send.mode === 'partial') return `${marketLabel(cell)}: ${word}.`
  if (cell.send.noLongerApplies) return `${marketLabel(cell)}: ${word} no longer applies. ${sentence(cell.send.noLongerApplies)}`
  const by = waitingSetPhrase(cell.send, now)
  return `${marketLabel(cell)}: ${word} waits for Publish${by ? `, ${by}` : ''}.`
}

/**
 * The Action every market ON the channel agrees on, or null when they differ (or none is on the channel: a market not on
 * the channel reads Full update but holds no value — it is never copied).
 */
export function commonSendMode(cells: readonly PublishActionCell[]): SendMode | null {
  const listed = cells.filter(cell => !cell.create)
  if (!listed.length) return null
  const first = listed[0].send.mode
  return listed.every(cell => cell.send.mode === first) ? first : null
}

/** One shared Action cell from the product's listings. */
export function sharedActionValue(cells: readonly PublishActionCell[], read: PublishCellReadState, now: number = Date.now()): SharedCellValue | undefined {
  if (!read.loaded) return undefined
  const total = cells.length
  const lines = cells.map(cell => sendLine(cell, now)).join('\n')
  const common = commonSendMode(cells)
  const lockedReason = read.failed && !total ? 'The publish action could not be read. Reload the sheet to try again.'
    : read.lockedReason ?? (!total ? SHARED_ACTION_NOT_LISTED : null)
  const quiet = (aria: string, tooltip: string, locked: string | null): SharedCellValue => ({
    kind: 'shared-action', pill: null, quiet: SEND_MODE_WORD.partial, aside: null, common, lockedReason: locked, total, ariaLabel: aria, tooltip,
  })
  if (lockedReason) return quiet(`Action: ${SEND_MODE_WORD.partial}. ${sentence(lockedReason)}`, composeCellTooltip(sentence(lockedReason), lines), lockedReason)
  // Markets not on the channel (new, or deleted by Nexus) read Full update and hold no value: named beside the others.
  const listedCells = cells.filter(cell => !cell.create)
  const notOn = cells.filter(cell => !!cell.create)
  const gone = deletedWords(cells)
  const freshCount = notOn.filter(cell => !cell.deleted).length
  const fresh = freshCount ? `${n(freshCount)} new` : null
  const waiting = sendWaitingOf(listedCells)
  if (!waiting && notOn.length === total) {
    // On no channel: Full update (sent whole) — quiet when every market's Status leaves it out.
    const goesOut = notOn.some(cell => cell.create!.target !== 'not_listed')
    const words = total > 1 ? `${SEND_MODE_WORD.full} on every market (${n(total)})` : SEND_MODE_WORD.full
    const aside = [total > 1 ? `${n(total)} markets` : null, gone].filter(Boolean).join(' · ') || null
    const hint = goesOut ? NEW_ROW_SENT_WHOLE : `${NEW_ROW_SENT_WHOLE} Every market's Status is Not listed, so Publish leaves ${total === 1 ? 'it' : 'them'} out.`
    return { kind: 'shared-action', pill: goesOut ? { label: SEND_MODE_WORD.full, tone: SEND_MODE_TONE.full, glyph: 'none' } : null, quiet: goesOut ? null : SEND_MODE_WORD.full,
      aside, common: null, lockedReason: null, total, notOnChannel: true, ariaLabel: `Action: ${words}. ${hint}`, tooltip: composeCellTooltip(`${words}: ${hint}`, lines) }
  }
  if (!waiting) {
    const listed = listedCells.length
    const where = total <= 1 ? '' : listed === total ? ` on every market (${n(total)})` : ` on ${n(listed)} of ${n(total)} markets`
    const asideWords = [gone, fresh].filter(Boolean).join(' · ') || null
    // A product already on Shopify, or on Etsy: Publish sends none of those markets' fields — said, never "only the fields you changed".
    const hint = sharedPartialHint(listedCells) ?? QUIET_HINT
    const quietValue = quiet(`Action: ${SEND_MODE_WORD.partial}${where}. ${hint}${asideWords ? ` ${sentence(asideWords)}` : ''}`, composeCellTooltip(`${SEND_MODE_WORD.partial}${where}: ${hint}`, lines), null)
    return asideWords ? { ...quietValue, aside: asideWords } : quietValue
  }
  const by = waiting.by ? waitingSetPhrase(waiting.by, now) : ''
  const word = waiting.value ? SEND_MODE_WORD[waiting.value] : null
  const label = word ? (waiting.count === total ? word : `${word} on ${n(waiting.count)} of ${n(total)}`) : `${n(waiting.count)} waiting`
  const tone = waiting.value ? SEND_MODE_TONE[waiting.value] : waiting.byValue.has('delete') ? 'danger' : 'info'
  const spread = word ? null : [...waiting.byValue].map(([mode, count]) => `${n(count)} ${SEND_MODE_WORD[mode].toLowerCase()}`).join(' · ')
  const aside = [spread, gone, fresh].filter(Boolean).join(' · ') || null
  const waits = word
    ? `${word} waits for Publish on ${waiting.count === total ? (total === 1 ? 'this market' : `every market (${n(total)})`) : `${n(waiting.count)} of ${n(total)} markets`}${by ? `, ${by}` : ''}.`
    : `${n(waiting.count)} Action changes wait for Publish: ${spread}${by ? `, ${by}` : ''}.`
  return {
    kind: 'shared-action', pill: { label, tone, glyph: 'clock' }, quiet: null, aside, common, lockedReason: null, total,
    ariaLabel: `Action: ${waits}`, tooltip: composeCellTooltip(waits, lines),
  }
}

/**
 * The editor's options for a product with several markets, counted; one market: exactly the channel cell's options. A
 * market Nexus deleted is counted as not allowed, with the reason (its own sheet lists it again).
 */
export function sharedActionEditorOptions(input: readonly PublishActionCell[], canDelete: boolean): SelectPanelOption[] {
  if (input.length === 1 && !input[0].deleted) return actionEditorChoices(input[0], canDelete)
  // A product new on every market: Full update (sent whole), the rest held with the reasons (as one new row's editor).
  if (input.length && input.every(cell => cell.create && !cell.deleted)) return actionEditorChoices(input[0], canDelete)
  const cells = input.map(sharedSendCell)
  const total = cells.length
  const waiting = sendWaitingOf(cells.filter(cell => !cell.create))
  return SEND_MODES.map(mode => {
    const base = { value: mode, label: SEND_MODE_WORD[mode], group: SEND_MODE_GROUP[mode] }
    const gone = cells.filter(cell => cell.deleted)
    if (mode === 'partial' && gone.length === total) return { ...base, heldReason: sharedDeletedRefusal(gone[0]), note: sharedDeletedRefusal(gone[0]) }
    if (mode === 'partial') {
      const skipped = gone.length ? ` ${n(gone.length)} deleted ${gone.length === 1 ? 'market stays' : 'markets stay'} as ${gone.length === 1 ? 'it is' : 'they are'}: set ${gone.length === 1 ? 'its' : 'their'} Status in ${gone.length === 1 ? 'its' : 'their'} own sheet.` : ''
      const note = sendModeDefaultNote(sharedPartialHint(cells.filter(cell => !cell.create)))
      return { ...base, note: `${waiting ? `Clears ${plural(waiting.count, 'waiting value', 'waiting values')}. ` : ''}${note}${skipped}` }
    }
    let allowed = 0
    let waitingHere = 0
    const reasons = new Map<string, number>()
    for (const cell of cells) {
      const option = cell.sendOptions.find(o => o.mode === mode)
      const roleRefused = mode === 'delete' && !!option?.offered && !canDelete
      if (option?.offered && !roleRefused) allowed += 1
      else { const why = roleRefused ? DELETE_NEEDS_DELETE : option?.reason?.trim() || SEND_MODE_REFUSED_FALLBACK; reasons.set(why, (reasons.get(why) ?? 0) + 1) }
      if (cell.send.mode === mode && !cell.send.noLongerApplies && !cell.create) waitingHere += 1
    }
    const top = [...reasons.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? SEND_MODE_REFUSED_FALLBACK
    if (!allowed) return { ...base, heldReason: top, note: top }
    const notes = [
      allowed === total ? `Every market (${n(total)}).` : `${n(allowed)} of ${n(total)} markets. ${n(total - allowed)} not allowed: ${sentence(top)}`,
      waitingHere ? `Waiting for Publish on ${waitingHere === total ? 'every market' : `${n(waitingHere)} of them`}.` : null,
      mode === 'delete' ? 'You confirm the listings first.' : null,
    ].filter(Boolean)
    return { ...base, note: notes.join(' ') }
  })
}

/**
 * What a shared Action cell received — editor, paste, fill (another shared cell's common value) or Delete (Partial
 * update). A market Nexus deleted refuses it when it is staged (`sharedDeletedRefusal`).
 */
export function parseSharedSendInput(raw: unknown): PublishCellInput {
  if (raw && typeof raw === 'object' && (raw as { kind?: unknown }).kind === 'shared-action') {
    const value = raw as SharedCellValue
    const common = value.common as SendMode | null
    // Copied from a product on no channel: its Full update holds no value, so nothing is copied.
    if (value.notOnChannel) return SKIP_CELL
    return common ? { change: { column: 'send', mode: common } } : { refused: SHARED_ACTION_MIXED_REFUSED }
  }
  if (raw && typeof raw === 'object' && (raw as { kind?: unknown }).kind === 'shared-status') return { refused: 'A Status is not an Action: use the Status column' }
  return parseSendInput(raw)
}

export function sharedActionColumn<Row>(input: SharedColumnInput<Row>): ColDef<Row> {
  const valueOf = (row: Row) => sharedActionValue(input.cells(row), input.read())
  return {
    colId: ACTION_COLUMN,
    headerName: SHARED_ACTION_LABEL,
    headerTooltip: SHARED_ACTION_TIP,
    width: SHARED_ACTION_WIDTH,
    minWidth: 130,
    sortable: false,
    cellClass: 'nds-ag-cell',
    cellClassRules: roundTripClassRules<Row>(input.tracker, input.rowIdOf),
    valueGetter: p => (p.data ? valueOf(p.data) : undefined),
    equals: samePublishCellValue,
    valueFormatter: p => sharedCellText(p.value as SharedCellValue | undefined),
    valueSetter: p => { if (p.data) input.onInput(p.data, parseSharedSendInput(p.newValue)); return false },
    editable: p => { const v = p.data ? valueOf(p.data) : undefined; return !!v && !v.lockedReason },
    cellEditor: SelectPanelEditor,
    cellEditorPopup: true,
    cellEditorPopupPosition: 'under',
    cellEditorParams: (p: { data?: Row }) => {
      const cells = p.data ? input.cells(p.data) : []
      return { value: commonSendMode(cells), options: sharedActionEditorOptions(cells, input.canDelete()) }
    },
    cellRenderer: SharedSummaryCell,
    tooltipValueGetter: p => composeCellTooltip(
      saveNote(p.data ? input.tracker.get(input.rowIdOf(p.data), ACTION_COLUMN) : undefined),
      (p.value as SharedCellValue | undefined)?.tooltip ?? 'Loading the publish action.',
    ),
    suppressKeyboardEvent: p => isClearKey(p.event, p.editing),
  }
}

// ── Action ▾ for the ticked products ─────────────────────────────────────────────────────────────

/** A ticked product as Action ▾ reads it: its SKU and its listings on every market (none = not listed yet). */
export interface SharedMenuRow { sku: string; cells: readonly PublishActionCell[] }

/**
 * The items of the shared Action ▾: the channel menu's items (`actionMenuEntries`), counted across every market of the
 * ticked products — "Inactive — 18 of 21 listings" — with the most common reason for the rest.
 */
export function sharedActionMenuEntries(rows: readonly SharedMenuRow[], can: { publish: boolean; delete: boolean }): ActionMenuEntry[] {
  // A market Nexus deleted takes no Status or Action from here (its own sheet lists it again): not allowed, with why.
  const flat = rows.flatMap((row): ActionMenuRow[] => (row.cells.length ? row.cells.map(cell => ({ sku: row.sku, cell: sharedCell(cell) })) : [{ sku: row.sku, cell: null }]))
  return actionMenuEntries(flat, can).map(entry => ({ ...entry, label: `${entry.label} ${entry.total === 1 ? 'listing' : 'listings'}` }))
}

// ── The typed confirmation of a shared Delete ────────────────────────────────────────────────────

export interface DeleteTarget { sku: string; cell: PublishActionCell }

/**
 * The confirmation a shared Delete asks before the value is SET (nothing is sent: Publish removes the listings, after
 * its own review and typed confirmation). Lists every listing it would remove, names the ones that refuse, and asks for
 * the SKU typed — for several products, the number of listings. Null when no listing allows Delete (the write's toast
 * says why) or the viewer may not delete (the editor holds the value already).
 */
export function sharedDeleteImpact(input: readonly DeleteTarget[], canDelete: boolean): ActionImpact | null {
  if (!canDelete) return null
  const targets = input.map(t => ({ ...t, cell: sharedSendCell(t.cell) }))
  const removes = targets.filter(t => t.cell.sendOptions.find(o => o.mode === 'delete')?.offered)
  if (!removes.length) return null
  const refused = targets.filter(t => !removes.includes(t))
  const skus = [...new Set(removes.map(t => t.sku))]
  const one = skus.length === 1
  const phrase = one ? skus[0] : String(removes.length)
  const what = plural(removes.length, 'listing', 'listings')
  return {
    level: 'type-to-confirm',
    title: one ? `Set Delete on ${what} of ${skus[0]}?` : `Set Delete on ${what} of ${n(skus.length)} products?`,
    consequences: removes.map(t => `${t.sku} · ${marketLabel(t.cell)} — removed from the channel when you press Publish; Nexus forgets its channel number.`),
    sideEffects: [
      'Nothing is sent now. Publish lists these deletes in its review and asks you to confirm them again.',
      'Until you press Publish, setting the Action back to Partial update takes this back.',
      'After Publish it cannot be undone: each listing then reads Not listed in its market\'s sheet. To list it again, set its Status there to Active and Publish.',
    ],
    findings: refused.map(t => ({ label: `${t.sku} · ${marketLabel(t.cell)} stays: ${sentence(t.cell.sendOptions.find(o => o.mode === 'delete')?.reason ?? SEND_MODE_REFUSED_FALLBACK)}`, severity: 'warn' as const })),
    confirmPhrase: phrase,
  }
}

// ── The one toast of a shared operation ─────────────────────────────────────────────────────────

/**
 * The toast of a shared operation: the channel sheet's `operationToast`, with each refused or conflicting listing named
 * by its product and market ("GALE-S · Amazon · DE (Amazon has no End…)") and counted in listings, not rows.
 */
export function sharedOperationToast(
  outcomes: readonly PublishActionWriteOutcome[],
  refusedEarly: ReadonlyArray<{ column: 'send' | 'status'; sku: string; reason: string }>,
  labelOf: (listingId: string) => string | null,
): ReturnType<typeof operationToast> {
  const relabel = (outcome: PublishActionWriteOutcome): PublishActionWriteOutcome => ({
    ...outcome,
    refused: outcome.refused.map(r => ({ ...r, sku: labelOf(r.listingId) ?? r.sku })),
    conflicts: outcome.conflicts.map(c => ({ ...c, sku: labelOf(c.listingId) ?? c.sku })),
  })
  const toast = operationToast(outcomes.map(relabel), refusedEarly)
  if (!toast) return null
  return { ...toast, message: listingWords(toast.message) }
}

/** "set on 5 rows." → "set on 5 listings." (and "1 row was changed" → "1 listing was changed"). */
export function listingWords(message: string): string {
  return message.replace(/\b(\d[\d,]*) rows\b/g, '$1 listings').replace(/\b1 row\b/g, '1 listing')
}

/** The label of a listing in a shared toast or confirm: "GALE-S · Amazon · DE". */
export const listingLabel = (sku: string, cell: PublishActionCell) => `${sku} · ${marketLabel(cell)}`

