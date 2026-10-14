/**
 * The bulk Edit's RUNNER (Owner 2026-10-07; v2 2026-10-12): the one place the dialog's preview and Apply reach a write door.
 *
 *   Base price      the master sheet writer (the page's `masterWrite`): one save for every row
 *   Sale            Matrix cell writes (`writeCells`), each cell built by the engine's `matrixWrite`
 *   Use base price  Matrix cell writes of `price: null` (the door hands the listing back to the base price); Undo builds
 *                   its writes as the page's ⌘Z does (`matrixReplay`)
 *   Status          each market's Status cells (the page's `statusWrite` → the publish actions), sent by Publish
 *   Case size,      their own dialogs, opened on the same rows (the page's `openElsewhere`)
 *   Stock source
 *   everything else the Matrix verbs: the server previews, the operator applies what was previewed, Undo reverts it
 *                   (B2B price and tiers too: the business price door, in the page's one write line)
 *
 * Every result sentence counts what the server ANSWERED, never what was asked for.
 *
 * 2026-10-13 (one save line): every Matrix write is built when its turn in the page's line comes (`writeCells` takes a
 * function), so an Undo clicked while a write is on its way works from the cells as that write left them; and an Undo
 * puts a cell back only while it still holds what Apply wrote — a newer value, the person's own or anyone else's, stays
 * (`MATRIX_COPY.changedSince`). The bulk Edit's Undo is its ONE way back: its writes are no ⌘Z step.
 */
import type { StatusTarget } from '@nexus/shared/listing-actions'

import { MATRIX_COPY, type CoordinateKey, type MatrixVerbRequest, type MatrixWriteCell, type MatrixWriteOutcome, type VerbOperation, type VerbPreview } from '../contract'
import { matrixWrite } from '@/design-system/grid'
import { matrixHistoryAfter, matrixHistoryBefore, matrixReplay, matrixStillHolds } from '../matrixUndo'

import {
  BULK_ALREADY_FOLLOWS, BULK_SENT, basePriceLines, bulkChoices, bulkCurrency, bulkCurrent, bulkDefaultMarkets, bulkDefaultMode, bulkFields,
  bulkMarkets, bulkMarketsNote, bulkNoun, bulkSent, countLines, dropsBy30, followBaseLines, isHandoffField, isVerbChangeLine, coordinateOfVerbLine,
  largeChangeWord, saleLines, saleNotices, statusLines, verbLines, verbNotices, verbParams, verbTargets, BULK_NO_HANDOFF,
  type BasePriceLine, type BulkContext, type FollowBaseLine, type SaleLine, type StatusLine,
} from './fields'
import type { BulkEditSource, BulkFieldId, BulkLine, BulkNotice, BulkPreview, BulkRequest, BulkResult } from './types'

/** A verb's run or revert as the server answered it: the operation, and each cell's outcome. */
export type VerbAnswer = VerbOperation & { results?: readonly MatrixWriteOutcome[] }

export interface BulkDoors {
  /** The context NOW (a write moves cells and versions): read at every preview and apply. The rows stay the opening's. */
  context: () => BulkContext
  previewVerb: (req: MatrixVerbRequest) => Promise<VerbPreview>
  applyVerb: (preview: VerbPreview) => Promise<VerbAnswer>
  /** Puts a verb's change back; the server's answer (what it put back, what it could not). */
  revertVerb: (op: VerbOperation) => Promise<VerbAnswer>
  /**
   * Matrix cell writes — QUIET: the dialog says the result, so nothing is toasted behind it. A function is called when the
   * writes' turn in the page's line comes (the cells as the writes before them left them); no cell = nothing is sent.
   */
  writeCells: (cells: readonly MatrixWriteCell[] | (() => readonly MatrixWriteCell[])) => Promise<MatrixWriteOutcome[]>
  /** Base price for these rows, as one save; each row's answer (a refusal carries the server's reason). */
  masterWrite: (writes: ReadonlyArray<{ rowId: string; value: number | null }>) => Promise<Array<{ rowId: string; ok: boolean; reason?: string }>>
  /** Each market's Status for these cells (a null target clears the waiting one); what was saved and what was refused. */
  statusWrite: (target: StatusTarget | null, places: ReadonlyArray<{ rowId: string; coordinateKey: CoordinateKey }>) => Promise<{ applied: ReadonlyArray<{ rowId: string; coordinateKey: CoordinateKey }>; refused: ReadonlyArray<{ rowId: string; coordinateKey: CoordinateKey; reason: string }> }>
  /** A hand-off field's door (Case size, Stock source): closes the dialog and opens the field's own on the same rows. */
  openElsewhere?: (field: BulkFieldId) => void
}

type Payload =
  | { kind: 'verb'; preview: VerbPreview }
  | { kind: 'master'; lines: BasePriceLine[] }
  | { kind: 'sale'; lines: SaleLine[] }
  | { kind: 'follow-base'; lines: FollowBaseLine[] }
  | { kind: 'status'; lines: StatusLine[] }
  | { kind: 'none' }

const skippedPart = (n: number) => (n > 0 ? ` · ${n} skipped` : '')
const placeKey = (rowId: string, key: CoordinateKey) => `${rowId}|${key}`
/** A `bulkCurrent` line's market (`field|now|row|coordinate`). */
const coordinateOfNow = (l: Pick<BulkLine, 'id'>): CoordinateKey => l.id.split('|')[3] ?? ''
/** `Sentence.` + ` Next sentence.` — the second one only when there is one. */
const and = (first: string, next: string) => (next ? `${first} ${next}` : first)
/** The lines as answered: a changing line the server refused is skipped with its reason; the rest as previewed. */
function answered<L extends BulkLine>(lines: readonly L[], refusedAt: (line: L) => string | null): L[] {
  return lines.map((l) => {
    if (l.skipped !== null) return l
    const reason = refusedAt(l)
    return reason === null ? l : { ...l, next: null, skipped: reason }
  })
}
const toneOf = (applied: number, skipped: number): BulkResult['tone'] => (applied === 0 ? 'danger' : skipped > 0 ? 'warning' : 'success')
/** An Undo's receipt: what was put back, and how many could not be with the first reason. */
const undoReceipt = (put: string, missed: number, why: string | undefined): string =>
  `Put back ${put}${missed > 0 ? ` · ${missed} could not be put back${why ? `: ${why}` : ''}` : ''}.`
/** Two amounts in cents: the grid's number and the preview's may differ in the last float digit. */
const sameAmount = (a: number | null | undefined, b: number | null | undefined): boolean =>
  a == null || b == null ? a == null && b == null : Math.round(a * 100) === Math.round(b * 100)
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
const outcomeReason = (o: MatrixWriteOutcome) => o.reason ?? (o.outcome === 'conflict' ? MATRIX_COPY.changedElsewhere : o.outcome === 'noop' ? 'Nothing to change' : 'Not changed')
/** Cell outcomes by place: the places applied, and why each other place was not. */
function byPlace(outcomes: readonly MatrixWriteOutcome[]): { applied: Set<string>; why: Map<string, string> } {
  const applied = new Set<string>()
  const why = new Map<string, string>()
  for (const o of outcomes) {
    const k = placeKey(o.rowId, o.coordinateKey)
    if (o.outcome === 'applied') applied.add(k)
    else why.set(k, outcomeReason(o))
  }
  return { applied, why }
}

/** The sentence a verb's result says: what changed, how many, and where it goes next. */
export function verbSentence(preview: Pick<VerbPreview, 'verb' | 'changes'>, applied: number, skipped: number): string {
  const s = skippedPart(skipped)
  const listings = plural(applied, 'listing', 'listings')
  const to = preview.changes[0]?.toLabel
  switch (preview.verb) {
    case 'set-price': case 'adjust-prices': case 'copy-prices': return and(`${bulkNoun('price', applied)} changed${s}.`, bulkSent(applied))
    case 'set-fulfilment': {
      // An Amazon coordinate is a real conversion (sent per market, confirmed from Amazon's report); eBay's is set in Nexus.
      const amazon = preview.changes.length > 0 && preview.changes.every((c) => c.coordinateKey.startsWith('AMAZON:'))
      const some = preview.changes.some((c) => c.coordinateKey.startsWith('AMAZON:'))
      if (amazon) return `${listings} sent to Amazon as ${to ?? 'the new method'}${s}. The Fulfilment cell says Confirmed when Amazon's report shows it (read every 15 min, up to 24 h).`
      if (some) return `${listings} set to ${to ?? 'the new method'}${s}. The Amazon ones are sent to Amazon and confirmed from its report; eBay's is set in Nexus.`
      return `${listings} set to ${to ?? 'the new method'} in Nexus${s}.`
    }
    case 'set-follow': return `${listings} now follow your stock${s}.`
    case 'pin-quantity': return and(`${listings} now show a fixed quantity${s}.`, bulkSent(applied))
    case 'set-buffer': return `${bulkNoun('buffer', applied)} changed${s}.`
    case 'pause-sync': return `Stock sync held on ${listings}${s}.`
    case 'resume-sync': return `Stock sync released on ${listings}${s}.`
    case 'push-now': return `${plural(applied, 'quantity push', 'quantity pushes')} sent${s}.`
    case 'retry-sync': return `${plural(applied, 'failed push', 'failed pushes')} sent again${s}.`
    case 'set-source': {
      // `to` is a code list; `[]` = the market default again (each market keeps its own default).
      const chosen = preview.changes.map((c) => c.to).find((t): t is string[] => Array.isArray(t) && t.length > 0)
      if (!chosen) return `${listings} ${applied === 1 ? 'uses its market default' : 'use their market default'} again${s}.`
      return `${listings} ${applied === 1 ? 'sells' : 'sell'} from ${chosen.join(' + ')}${s}.`
    }
    // Amazon Business: each change carries the whole setting it writes (`null` = no business price).
    case 'set-business-price': {
      const removed = preview.changes.length > 0 && preview.changes.every((c) => c.to === null)
      return and(`${bulkNoun('businessPrice', applied)} ${removed ? 'removed' : 'set'}${s}.`, applied > 0 ? BULK_SENT.business : '')
    }
    case 'set-business-tiers': {
      const removed = preview.changes.length > 0 && preview.changes.every((c) => (c.to as { tiers?: unknown } | null)?.tiers == null)
      return and(`Quantity discounts ${removed ? 'removed from' : 'set on'} ${listings}${s}.`, applied > 0 ? BULK_SENT.business : '')
    }
  }
}

/**
 * The Undo receipt of a verb, counting what the server PUT BACK: a listing is put back when none of its writes was
 * refused; the first refusal's reason is said.
 */
export function revertSentence(answer: Pick<VerbAnswer, 'applied' | 'refused' | 'results'>): string {
  if (!answer.results) return `Put back ${plural(answer.applied, 'change', 'changes')}${answer.refused > 0 ? ` · ${answer.refused} could not be put back` : ''}.`
  const refused = new Map<string, string>()
  const seen = new Set<string>()
  for (const o of answer.results) {
    const k = placeKey(o.rowId, o.coordinateKey)
    seen.add(k)
    if ((o.outcome === 'refused' || o.outcome === 'conflict') && !refused.has(k)) refused.set(k, outcomeReason(o))
  }
  const back = seen.size - refused.size
  const first = [...refused.values()][0]
  return `Put back ${plural(back, 'listing', 'listings')} as ${back === 1 ? 'it was' : 'they were'}${refused.size > 0 ? ` · ${refused.size} could not be put back: ${first}` : ''}.`
}

export function createBulkSource(doors: BulkDoors, opening: { title: string; subtitle: string }): BulkEditSource {
  const preview = async (request: BulkRequest): Promise<BulkPreview> => {
    const ctx = doors.context()
    const { field, mode, input, coordinateKeys } = request
    const done = (lines: BulkLine[], payload: Payload, notices: BulkNotice[], confirmWord: string | null, undoable = true): BulkPreview => {
      const { changes, skipped } = countLines(lines)
      return { request, lines, changes, skipped, notices, confirmWord: changes > 0 ? confirmWord : null, undoable, payload }
    }
    if (isHandoffField(field)) return done([], { kind: 'none' }, [], null, false)
    if (field === 'basePrice') {
      const lines = basePriceLines(ctx, mode, input, bulkCurrency(ctx, field, []))
      const { changes } = countLines(lines)
      return done(lines, { kind: 'master', lines }, [{ text: BULK_SENT.followers, tone: 'info' }], largeChangeWord(changes) ?? (dropsBy30(lines) ? 'APPLY' : null))
    }
    if (field === 'salePrice') {
      const lines = saleLines(ctx, mode, input, coordinateKeys)
      return done(lines, { kind: 'sale', lines }, saleNotices(ctx, mode, coordinateKeys), largeChangeWord(countLines(lines).changes))
    }
    if (field === 'listingStatus') {
      const target = input.choice as StatusTarget | undefined
      if (!target) throw new Error('Choose a status first')
      const lines = statusLines(ctx, target, coordinateKeys)
      return done(lines, { kind: 'status', lines }, [], largeChangeWord(countLines(lines).changes))
    }
    if (field === 'price' && mode === 'follow-base') {
      const lines = followBaseLines(ctx, coordinateKeys)
      return done(lines, { kind: 'follow-base', lines }, [{ text: BULK_SENT.prices, tone: 'info' }], largeChangeWord(countLines(lines).changes))
    }
    const params = verbParams(field, mode, input, bulkCurrency(ctx, field, coordinateKeys))
    if (!params) throw new Error('Choose a value first')
    // Copy from: the market copied from is never a target of its own copy.
    const targets = verbTargets(ctx, field, coordinateKeys, params.verb === 'copy-prices' ? params.fromCoordinateKey : null)
    const undoable = params.verb !== 'push-now' && params.verb !== 'retry-sync'
    if (targets.length === 0) return done([], { kind: 'verb', preview: { verb: params.verb, changes: [], refusals: [], notices: [], confirm: 'none', confirmWord: null, simulated: false } }, [], null, undoable)
    const pv = await doors.previewVerb({ params, targets, commit: false })
    // A refused line's Now is the row as it is (the server says only why it refused).
    const now = new Map(bulkCurrent(ctx, field, coordinateKeys).map((l) => [placeKey(l.rowId, coordinateOfNow(l)), l.now]))
    return done(verbLines(pv, ctx, request, (rowId, key) => now.get(placeKey(rowId, key)) ?? null), { kind: 'verb', preview: pv }, verbNotices(pv),
      pv.confirm === 'type-to-confirm' ? pv.confirmWord : null, undoable)
  }

  const apply = async (shown: BulkPreview): Promise<BulkResult> => {
    const payload = shown.payload as Payload

    if (payload.kind === 'none') throw new Error('This field opens its own editor')

    if (payload.kind === 'verb') {
      const op = await doors.applyVerb(payload.preview)
      const skipped = payload.preview.refusals.length + op.refused
      const canUndo = shown.undoable && op.applied > 0
      const refused = new Map((op.results ?? []).filter((r) => r.outcome !== 'applied').map((r) => [placeKey(r.rowId, r.coordinateKey), outcomeReason(r)]))
      return {
        applied: op.applied, skipped, tone: toneOf(op.applied, skipped),
        ...(op.results ? { lines: answered(shown.lines, (l) => (isVerbChangeLine(l) ? refused.get(placeKey(l.rowId, coordinateOfVerbLine(l))) ?? null : null)) } : {}),
        sentence: verbSentence(payload.preview, op.applied, skipped),
        undo: canUndo ? async () => revertSentence(await doors.revertVerb(op)) : null,
      }
    }

    if (payload.kind === 'master') {
      const changing = payload.lines.filter((l) => l.skipped === null && l.value != null)
      const answers = await doors.masterWrite(changing.map((l) => ({ rowId: l.rowId, value: l.value })))
      const ok = answers.filter((a) => a.ok).map((a) => a.rowId)
      const skipped = shown.skipped + (answers.length - ok.length)
      const why = new Map(answers.filter((a) => !a.ok).map((a) => [a.rowId, a.reason ?? 'Not saved']))
      const back = changing.filter((l) => ok.includes(l.rowId))
      return {
        applied: ok.length, skipped, tone: toneOf(ok.length, skipped),
        sentence: and(`${bulkNoun('basePrice', ok.length)} changed${skippedPart(skipped)}.`, ok.length > 0 ? BULK_SENT.followers : ''),
        lines: answered(shown.lines, (l) => why.get(l.rowId) ?? null),
        undo: back.length ? async () => {
          // Only a row that still holds the base price Apply wrote is put back: a newer one stays.
          const ctx = doors.context()
          const now = (rowId: string) => (ctx.basePriceNow ? ctx.basePriceNow(rowId) : ctx.rows.find((r) => r.id === rowId)?.basePrice ?? null)
          const held = back.filter((l) => sameAmount(now(l.rowId), l.value))
          const undone = held.length ? await doors.masterWrite(held.map((l) => ({ rowId: l.rowId, value: l.before }))) : []
          const refused = undone.filter((a) => !a.ok)
          const missed = back.length - held.length + refused.length
          return undoReceipt(bulkNoun('basePrice', undone.length - refused.length), missed, held.length < back.length ? MATRIX_COPY.changedSince : refused[0]?.reason ?? 'Not saved')
        } : null,
      }
    }

    if (payload.kind === 'sale') {
      /* The cells are built when their turn comes (the cells as the writes ahead left them). Undo: a cell is put back only
         while it still shows the sale Apply wrote. */
      const send = async (lines: readonly SaleLine[], valueOf: (l: SaleLine) => SaleLine['value'], undo = false) => {
        const early = new Map<string, string>()
        const outcomes = await doors.writeCells(() => {
          const ctx = doors.context()
          const cells: MatrixWriteCell[] = []
          early.clear()
          for (const l of lines) {
            const k = placeKey(l.rowId, l.coordinateKey)
            const now = ctx.cellsOf(l.rowId, l.coordinateKey)
            if (undo && matrixStillHolds('salePrice', l.value, now) === false) { early.set(k, MATRIX_COPY.changedSince); continue }
            const decision = matrixWrite({ kind: 'salePrice', coordinateKey: l.coordinateKey, rowId: l.rowId }, now, now?.sale ?? null, valueOf(l))
            if (decision.send) cells.push(decision.cell)
            else early.set(k, decision.reason)
          }
          return cells
        })
        return { ...byPlace(outcomes), early }
      }
      const changing = payload.lines.filter((l) => l.skipped === null)
      const r = await send(changing, (l) => l.value)
      const applied = r.applied.size
      const skipped = shown.skipped + (changing.length - applied)
      const back = changing.filter((l) => r.applied.has(placeKey(l.rowId, l.coordinateKey)))
      return {
        applied, skipped, tone: toneOf(applied, skipped),
        lines: answered(shown.lines as SaleLine[], (l) => { const k = placeKey(l.rowId, l.coordinateKey); return r.applied.has(k) ? null : r.why.get(k) ?? r.early.get(k) ?? 'Not saved' }),
        sentence: and(`${bulkNoun('salePrice', applied)} ${shown.request.mode === 'sale-remove' ? 'removed' : 'set'}${skippedPart(skipped)}.`, bulkSent(applied)),
        undo: back.length ? async () => {
          const u = await send(back, (l) => l.before, true)
          const why = back.map((l) => placeKey(l.rowId, l.coordinateKey)).filter((k) => !u.applied.has(k)).map((k) => u.why.get(k) ?? u.early.get(k)).find(Boolean)
          return undoReceipt(bulkNoun('salePrice', u.applied.size), back.length - u.applied.size, why)
        } : null,
      }
    }

    if (payload.kind === 'follow-base') {
      const changing = payload.lines.filter((l) => l.skipped === null)
      const early = new Map<string, string>()
      const r = byPlace(await doors.writeCells(() => {
        const ctx = doors.context()
        const cells: MatrixWriteCell[] = []
        early.clear()
        for (const l of changing) {
          const now = ctx.cellsOf(l.rowId, l.coordinateKey)
          const k = placeKey(l.rowId, l.coordinateKey)
          // The same checks as the preview, on the cell as it is NOW (a write may have moved it while the dialog was open).
          if (!now?.price || now.listingId !== l.before.listingId) early.set(k, MATRIX_COPY.changedElsewhere)
          else if (now.price.source === 'master') early.set(k, BULK_ALREADY_FOLLOWS)
          else if (now.writable.price !== true) early.set(k, now.writeBlockedReason.price ?? 'The price cannot be changed on this market')
          else cells.push({ rowId: l.rowId, coordinateKey: l.coordinateKey, cell: 'price', value: null, expectedVersion: now.version, ...(now.listingId ? { expectedListingId: now.listingId } : {}) })
        }
        return cells
      }))
      const applied = r.applied.size
      const skipped = shown.skipped + (changing.length - applied)
      const back = changing.filter((l) => r.applied.has(placeKey(l.rowId, l.coordinateKey)))
      return {
        applied, skipped, tone: toneOf(applied, skipped),
        lines: answered(shown.lines as FollowBaseLine[], (l) => { const k = placeKey(l.rowId, l.coordinateKey); return r.applied.has(k) ? null : r.why.get(k) ?? early.get(k) ?? 'Not saved' }),
        sentence: and(`${plural(applied, 'market now follows', 'markets now follow')} the base price${skippedPart(skipped)}.`, applied > 0 ? BULK_SENT.it : ''),
        undo: back.length ? async () => {
          /* The page's ⌘Z road: each price back as it was (its own number, set here), at the cell's version when the writes'
             turn comes — and only while it still follows the base price, as Apply left it (a newer price stays). */
          const said = new Map<string, string>()
          let already = 0
          const u = byPlace(await doors.writeCells(() => {
            const live = doors.context()
            const writes: MatrixWriteCell[] = []
            said.clear(); already = 0
            for (const l of back) {
              const step = matrixReplay('price', matrixHistoryBefore(l.before, matrixHistoryAfter(null)), live.cellsOf(l.rowId, l.coordinateKey), { rowId: l.rowId, coordinateKey: l.coordinateKey })
              if (step.kind === 'write') writes.push(step.cell)
              else if (step.kind === 'refuse') said.set(placeKey(l.rowId, l.coordinateKey), step.reason)
              else already += 1
            }
            return writes
          }))
          const why = back.map((l) => placeKey(l.rowId, l.coordinateKey)).filter((k) => !u.applied.has(k)).map((k) => u.why.get(k) ?? said.get(k)).find(Boolean)
          return undoReceipt(bulkNoun('price', u.applied.size), back.length - already - u.applied.size, why)
        } : null,
      }
    }

    // Status: one write per target value; undo puts back each cell's own earlier waiting value.
    const changing = payload.lines.filter((l) => l.skipped === null)
    const target = changing[0]?.target ?? (shown.request.input.choice as StatusTarget)
    const r = await doors.statusWrite(target, changing.map((l) => ({ rowId: l.rowId, coordinateKey: l.coordinateKey })))
    const applied = r.applied.length
    const skipped = shown.skipped + r.refused.length
    const why = new Map(r.refused.map((x) => [placeKey(x.rowId, x.coordinateKey), x.reason]))
    const saved = new Set(r.applied.map((a) => placeKey(a.rowId, a.coordinateKey)))
    const back = changing.filter((l) => saved.has(placeKey(l.rowId, l.coordinateKey)))
    return {
      applied, skipped, tone: toneOf(applied, skipped),
      sentence: and(`${bulkNoun('listingStatus', applied)} set to ${changing[0]?.next ?? 'the new status'}${skippedPart(skipped)}.`, applied > 0 ? `Publish sends ${applied === 1 ? 'it' : 'them'} to the markets.` : ''),
      lines: answered(shown.lines as StatusLine[], (l) => (saved.has(placeKey(l.rowId, l.coordinateKey)) ? null : why.get(placeKey(l.rowId, l.coordinateKey)) ?? 'Not saved')),
      undo: back.length ? async () => {
        const groups = new Map<StatusTarget | null, StatusLine[]>()
        for (const l of back) groups.set(l.before, [...(groups.get(l.before) ?? []), l])
        let n = 0
        for (const [before, lines] of groups) n += (await doors.statusWrite(before, lines.map((l) => ({ rowId: l.rowId, coordinateKey: l.coordinateKey })))).applied.length
        return `Put back ${bulkNoun('listingStatus', n)}${n < back.length ? ` · ${back.length - n} could not be put back` : ''}.`
      } : null,
    }
  }

  const ctx0 = doors.context()
  return {
    title: opening.title,
    subtitle: opening.subtitle,
    // Without the page's door a hand-off cannot open: held, with the reason (never a silent button).
    fields: bulkFields(ctx0).map((f) => (isHandoffField(f.id) && !doors.openElsewhere ? { ...f, held: f.held ?? BULK_NO_HANDOFF } : f)),
    marketsFor: (field) => bulkMarkets(doors.context(), field),
    marketsNote: (field) => bulkMarketsNote(doors.context(), field),
    defaultMarkets: (field) => bulkDefaultMarkets(doors.context(), field),
    defaultMode: (field, keys) => bulkDefaultMode(doors.context(), field, keys),
    current: (field, keys) => bulkCurrent(doors.context(), field, keys),
    choicesFor: (field, mode, keys) => bulkChoices(doors.context(), field, mode, keys),
    currencyFor: (field, keys) => bulkCurrency(doors.context(), field, keys),
    locations: ctx0.locations ?? [],
    preview,
    apply,
    ...(doors.openElsewhere ? { openElsewhere: doors.openElsewhere } : {}),
  }
}
