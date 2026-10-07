/**
 * The bulk Edit's RUNNER (Owner 2026-10-07): the one place the dialog's preview and Apply reach a write door.
 *
 *   Base price      the master sheet writer (the page's `masterWrite`): one save for every row
 *   Sale price      Matrix cell writes (`matrix.write`), each cell built by the engine's `matrixWrite`
 *   Status          each market's Status cells (the page's `statusWrite` → the publish actions), sent by Publish
 *   everything else the Matrix verbs: the server previews, the operator applies what was previewed, Undo reverts it
 *
 * Every result sentence counts what the server ANSWERED, never what was asked for.
 */
import type { StatusTarget } from '@nexus/shared/listing-actions'

import type { CoordinateKey, MatrixVerbRequest, MatrixWriteCell, MatrixWriteOutcome, VerbOperation, VerbPreview } from '../contract'
import { matrixWrite } from '@/design-system/grid'

import {
  BULK_BASE_PRICE_NOTICE, BULK_SALE_NOTICE, BULK_STATUS_NOTICE, basePriceLines, bulkChoices, bulkCurrency, bulkDefaultMarkets, bulkFields,
  bulkMarkets, bulkNoun, countLines, largeChangeWord, saleLines, statusLines, verbLines, verbNotices, verbParams, verbTargets,
  type BulkContext, type SaleLine, type StatusLine,
} from './fields'
import type { BulkEditSource, BulkLine, BulkPreview, BulkRequest, BulkResult } from './types'

export interface BulkDoors {
  /** The context NOW (a write moves cells and versions): read at every preview and apply. The rows stay the opening's. */
  context: () => BulkContext
  previewVerb: (req: MatrixVerbRequest) => Promise<VerbPreview>
  applyVerb: (preview: VerbPreview) => Promise<VerbOperation>
  revertVerb: (op: VerbOperation) => Promise<void>
  writeCells: (cells: readonly MatrixWriteCell[]) => Promise<MatrixWriteOutcome[]>
  /** Base price for these rows, as one save; each row's answer (a refusal carries the server's reason). */
  masterWrite: (writes: ReadonlyArray<{ rowId: string; value: number | null }>) => Promise<Array<{ rowId: string; ok: boolean; reason?: string }>>
  /** Each market's Status for these cells (a null target clears the waiting one); what was saved and what was refused. */
  statusWrite: (target: StatusTarget | null, places: ReadonlyArray<{ rowId: string; coordinateKey: CoordinateKey }>) => Promise<{ applied: ReadonlyArray<{ rowId: string; coordinateKey: CoordinateKey }>; refused: number }>
}

type Payload =
  | { kind: 'verb'; preview: VerbPreview }
  | { kind: 'master'; lines: ReturnType<typeof basePriceLines> }
  | { kind: 'sale'; lines: SaleLine[] }
  | { kind: 'status'; lines: StatusLine[] }

const skippedPart = (n: number) => (n > 0 ? ` · ${n} skipped` : '')
const toneOf = (applied: number, skipped: number): BulkResult['tone'] => (applied === 0 ? 'danger' : skipped > 0 ? 'warning' : 'success')
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** The sentence a verb's result says: what changed, how many, and where it goes next. */
export function verbSentence(preview: Pick<VerbPreview, 'verb' | 'changes'>, applied: number, skipped: number): string {
  const s = skippedPart(skipped)
  const listings = plural(applied, 'listing', 'listings')
  const to = preview.changes[0]?.toLabel
  switch (preview.verb) {
    case 'set-price': case 'adjust-prices': case 'copy-prices': return `${bulkNoun('price', applied)} changed${s}. Nexus sends ${applied === 1 ? 'it' : 'them'} in about 30 seconds.`
    case 'set-fulfilment': return `${listings} set to ${to ?? 'the new method'} in Nexus${s}. Convert the offer in Seller Central too.`
    case 'set-follow': return `${listings} now follow your stock${s}.`
    case 'pin-quantity': return `${listings} now show a fixed quantity${s}. Nexus sends it in about 30 seconds.`
    case 'set-buffer': return `${bulkNoun('buffer', applied)} changed${s}.`
    case 'pause-sync': return `Stock sync held on ${listings}${s}.`
    case 'resume-sync': return `Stock sync released on ${listings}${s}.`
    case 'push-now': return `${plural(applied, 'quantity push', 'quantity pushes')} sent${s}.`
    case 'retry-sync': return `${plural(applied, 'failed push', 'failed pushes')} sent again${s}.`
  }
}

export function createBulkSource(doors: BulkDoors, opening: { title: string; subtitle: string }): BulkEditSource {
  const labelOf = (key: CoordinateKey) => doors.context().coordinates.find((c) => c.key === key)?.label ?? key

  const preview = async (request: BulkRequest): Promise<BulkPreview> => {
    const ctx = doors.context()
    const { field, mode, input, coordinateKeys } = request
    const done = (lines: BulkLine[], payload: Payload, notices: string[], confirmWord: string | null, undoable = true): BulkPreview => {
      const { changes, skipped } = countLines(lines)
      return { request, lines, changes, skipped, notices, confirmWord: changes > 0 ? confirmWord : null, undoable, payload }
    }
    if (field === 'basePrice') {
      const lines = basePriceLines(ctx, mode, input, bulkCurrency(ctx, field, []))
      const { changes } = countLines(lines)
      return done(lines, { kind: 'master', lines }, [BULK_BASE_PRICE_NOTICE], largeChangeWord(changes, mode === 'adjust' ? input.percent : undefined))
    }
    if (field === 'salePrice') {
      const lines = saleLines(ctx, mode, input, coordinateKeys)
      return done(lines, { kind: 'sale', lines }, mode === 'sale-set' ? [BULK_SALE_NOTICE] : [], largeChangeWord(countLines(lines).changes))
    }
    if (field === 'listingStatus') {
      const target = input.choice as StatusTarget | undefined
      if (!target) throw new Error('Choose a status first')
      const lines = statusLines(ctx, target, coordinateKeys)
      return done(lines, { kind: 'status', lines }, [BULK_STATUS_NOTICE], largeChangeWord(countLines(lines).changes))
    }
    const params = verbParams(field, mode, input)
    if (!params) throw new Error('Choose a value first')
    const targets = verbTargets(ctx, field, coordinateKeys)
    if (targets.length === 0) return done([], { kind: 'verb', preview: { verb: params.verb, changes: [], refusals: [], notices: [], confirm: 'none', confirmWord: null, simulated: false } }, [], null)
    const pv = await doors.previewVerb({ params, targets, commit: false })
    return done(verbLines(pv, labelOf), { kind: 'verb', preview: pv }, verbNotices(pv),
      pv.confirm === 'type-to-confirm' ? pv.confirmWord : null, params.verb !== 'push-now' && params.verb !== 'retry-sync')
  }

  const apply = async (shown: BulkPreview): Promise<BulkResult> => {
    const payload = shown.payload as Payload
    const field = shown.request.field

    if (payload.kind === 'verb') {
      const op = await doors.applyVerb(payload.preview)
      const skipped = payload.preview.refusals.length + op.refused
      const canUndo = shown.undoable && op.applied > 0
      return {
        applied: op.applied, skipped, tone: toneOf(op.applied, skipped),
        sentence: verbSentence(payload.preview, op.applied, skipped),
        undo: canUndo ? async () => { await doors.revertVerb(op); return `Put back ${plural(op.before.length, 'listing', 'listings')} as they were.` } : null,
      }
    }

    if (payload.kind === 'master') {
      const changing = payload.lines.filter((l) => l.skipped === null && l.value != null)
      const answers = await doors.masterWrite(changing.map((l) => ({ rowId: l.rowId, value: l.value })))
      const ok = answers.filter((a) => a.ok).map((a) => a.rowId)
      const skipped = shown.skipped + (answers.length - ok.length)
      const back = changing.filter((l) => ok.includes(l.rowId)).map((l) => ({ rowId: l.rowId, value: l.before }))
      return {
        applied: ok.length, skipped, tone: toneOf(ok.length, skipped),
        sentence: `${bulkNoun('basePrice', ok.length)} changed${skippedPart(skipped)}. Markets that follow it get the new price in about 30 seconds.`,
        undo: back.length ? async () => {
          const undone = await doors.masterWrite(back)
          return `Put back ${bulkNoun('basePrice', undone.filter((a) => a.ok).length)}.`
        } : null,
      }
    }

    if (payload.kind === 'sale') {
      const send = async (lines: readonly SaleLine[], valueOf: (l: SaleLine) => SaleLine['value']) => {
        const ctx = doors.context()
        const cells: MatrixWriteCell[] = []
        const early: string[] = []
        for (const l of lines) {
          const now = ctx.cellsOf(l.rowId, l.coordinateKey)
          const decision = matrixWrite({ kind: 'salePrice', coordinateKey: l.coordinateKey, rowId: l.rowId }, now, now?.sale ?? null, valueOf(l))
          if (decision.send) cells.push(decision.cell)
          else early.push(decision.reason)
        }
        const outcomes = cells.length ? await doors.writeCells(cells) : []
        return { outcomes, early }
      }
      const changing = payload.lines.filter((l) => l.skipped === null)
      const { outcomes, early } = await send(changing, (l) => l.value)
      const appliedKeys = new Set(outcomes.filter((o) => o.outcome === 'applied').map((o) => `${o.rowId}|${o.coordinateKey}`))
      const applied = appliedKeys.size
      const skipped = shown.skipped + early.length + (outcomes.length - applied)
      const back = changing.filter((l) => appliedKeys.has(`${l.rowId}|${l.coordinateKey}`))
      return {
        applied, skipped, tone: toneOf(applied, skipped),
        sentence: `${bulkNoun('salePrice', applied)} ${shown.request.mode === 'sale-remove' ? 'removed' : 'set'}${skippedPart(skipped)}. Nexus sends ${applied === 1 ? 'it' : 'them'} in about 30 seconds.`,
        undo: back.length ? async () => {
          const r = await send(back, (l) => l.before)
          return `Put back ${bulkNoun('salePrice', r.outcomes.filter((o) => o.outcome === 'applied').length)}.`
        } : null,
      }
    }

    // Status: one write per target value; undo puts back each cell's own earlier waiting value.
    const changing = payload.lines.filter((l) => l.skipped === null)
    const target = changing[0]?.target ?? (shown.request.input.choice as StatusTarget)
    const r = await doors.statusWrite(target, changing.map((l) => ({ rowId: l.rowId, coordinateKey: l.coordinateKey })))
    const applied = r.applied.length
    const skipped = shown.skipped + r.refused
    const done = new Set(r.applied.map((a) => `${a.rowId}|${a.coordinateKey}`))
    const back = changing.filter((l) => done.has(`${l.rowId}|${l.coordinateKey}`))
    return {
      applied, skipped, tone: toneOf(applied, skipped),
      sentence: `${bulkNoun('listingStatus', applied)} set to ${changing[0]?.next ?? 'the new status'}${skippedPart(skipped)}. Publish sends ${applied === 1 ? 'it' : 'them'} to the markets.`,
      undo: back.length ? async () => {
        const groups = new Map<StatusTarget | null, StatusLine[]>()
        for (const l of back) groups.set(l.before, [...(groups.get(l.before) ?? []), l])
        let n = 0
        for (const [before, lines] of groups) n += (await doors.statusWrite(before, lines.map((l) => ({ rowId: l.rowId, coordinateKey: l.coordinateKey })))).applied.length
        return `Put back ${bulkNoun('listingStatus', n)}.`
      } : null,
    }
  }

  const ctx0 = doors.context()
  return {
    title: opening.title,
    subtitle: opening.subtitle,
    fields: bulkFields(ctx0),
    marketsFor: (field) => bulkMarkets(doors.context(), field),
    defaultMarkets: (field) => bulkDefaultMarkets(doors.context(), field),
    choicesFor: (field, mode, keys) => bulkChoices(doors.context(), field, mode, keys),
    currencyFor: (field, keys) => bulkCurrency(doors.context(), field, keys),
    preview,
    apply,
  }
}

