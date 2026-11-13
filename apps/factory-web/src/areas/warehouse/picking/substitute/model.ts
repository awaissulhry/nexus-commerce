import { SUBSTITUTION_LIMITS } from '@nexus/factory-domain/inventory/substitutions/rules'
import { isApiError, issuePath } from '../../../../lib/api/errors'
import type { Phrase, Tone } from '../../../_shared/stock/model'
import type { AskBody, BomLineChoice, BomRows, StockLot, SubstituteChoice, SubstituteOptions, Substitution, SubstitutionStatus } from './api'

/**
 * B-W2b-320 — "Use a substitute", pure: who may ask (inventory.issue) and see the list (inventory.stock.view), the work
 * order's BOM lines of a material, why a choice or a lot is held (from the codes and facts of B-W2b-298's answer, never its
 * English), the ask's draft, its check and body, a refusal in our words, and the statuses' tones. Nobody approves their own
 * request: the yes is another person's, in Home › Approvals. Words are keys of `warehouse-lots-counts` (`sb.*`).
 */

export const SUB_NAMESPACE = 'warehouse-lots-counts'

export interface SubCan {
  /** Ask for a substitute, read the dialog, withdraw one (inventory.issue: warehouse, production manager). */
  ask: boolean
  /** The list of substitutes and the tile (inventory.stock.view). */
  view: boolean
}
export function subCan(permissions: readonly string[]): SubCan {
  const held = new Set(permissions)
  return { ask: held.has('inventory.issue'), view: held.has('inventory.stock.view') }
}

export const STATUS_TONE: Readonly<Record<SubstitutionStatus, Tone>> = Object.freeze({ WAITING: 'warning', APPROVED: 'success', ISSUED: 'info', REFUSED: 'danger', WITHDRAWN: 'neutral' })

/**
 * The work order's BOM lines, the given material's (and colour's) only, each with what is still to issue. One entry per BOM
 * line: a line whose colour follows the garment's comes once per colour in the pick read, and the substitute's options are
 * the BOM line's, so its colours are said together.
 */
export function bomLinesOf(rows: BomRows, material?: { itemId: string; itemColourId: string | null } | null): BomLineChoice[] {
  const byLine = new Map<string, BomLineChoice>()
  for (const line of rows.lines) {
    if (material && (line.itemId !== material.itemId || (line.itemColourId ?? null) !== (material.itemColourId ?? null))) continue
    for (const row of line.rows) {
      const entry = byLine.get(row.bomLineId) ?? { bomLineId: row.bomLineId, seq: row.bomSeq, placement: row.placement, itemId: line.itemId, itemCode: line.itemCode, itemName: line.itemName, itemColourId: line.itemColourId, colourCode: line.colourCode, baseUom: line.baseUom, planned: 0, toIssue: 0 }
      if (line.colourCode && entry.colourCode !== line.colourCode && !(entry.colourCode ?? '').split(', ').includes(line.colourCode)) {
        entry.colourCode = entry.colourCode ? `${entry.colourCode}, ${line.colourCode}` : line.colourCode
        if (entry.itemColourId !== line.itemColourId) entry.itemColourId = null
      }
      entry.planned += Number(row.planned) || 0
      entry.toIssue += Number(row.toIssue) || 0
      byLine.set(row.bomLineId, entry)
    }
  }
  return [...byLine.values()].sort((a, b) => a.seq - b.seq)
}

/** Why a lot of the substitute is not named now (released, its chromium VI test, a hold), from its facts. */
export function lotHeld(lot: StockLot): Phrase | null {
  if (lot.usable) return null
  if (!lot.lot) return { key: 'sb.lot.held' }
  if (lot.lot.qualityStatus !== 'RELEASED') return { key: `sb.lot.quality.${lot.lot.qualityStatus}`, params: { code: lot.lot.code } }
  if (lot.lot.requiresCrViTest && lot.lot.crViStatus !== 'PASS') return { key: 'sb.lot.crVi', params: { code: lot.lot.code } }
  return { key: 'sb.lot.hold', params: { code: lot.lot.code } }
}

const positive = (text: string | null | undefined): boolean => text !== null && text !== undefined && Number(text) > 0

/** Why a choice cannot be asked for now (B-W2b-298's order: the rule, nothing left, nobody could decide, no stock). */
export function choiceHeld(choice: SubstituteChoice): Phrase | null {
  if (choice.refusal) return { key: `sb.refusal.${choice.refusal.code}` }
  if (choice.max !== null && !positive(choice.max)) return { key: 'sb.held.nothingLeft' }
  if (choice.needsPerson && !choice.approval.asks) return { key: choice.approval.namedSelf ? 'sb.held.namedSelf' : 'sb.refusal.NO_APPROVER' }
  if (choice.stock.lots.every((lot) => !lot.usable)) return { key: 'sb.held.noStock', params: { code: choice.item.code } }
  if (!choice.mayAsk) return { key: 'sb.held.other' }
  return null
}

/** The rule of a choice in words: another lot of the own material, or the alternate's "use when". */
export const ruleWords = (choice: SubstituteChoice): Phrase => (choice.alternate ? { key: `sb.use.${choice.alternate.allowedWhen}` } : { key: 'sb.use.OWN' })

/** Who says yes: the rule's approver, approved at once (the BOM allows it, no rule asks), or nobody (held). */
export function approvalWords(choice: SubstituteChoice): Phrase {
  if (choice.approval.asks) return choice.approval.approver ? { key: choice.approval.approver.kind === 'ROLE' ? 'sb.approval.role' : 'sb.approval.person', params: { name: choice.approval.approver.name } } : { key: 'sb.approval.rule' }
  return choice.needsPerson ? { key: 'sb.approval.nobody' } : { key: 'sb.approval.atOnce' }
}

/** The certificate check: covered by a valid certificate today, needed and missing, or not needed. */
export function certificateWords(choice: SubstituteChoice): Phrase | null {
  if (!choice.certificateRequired) return null
  return choice.certificate ? { key: 'sb.cert.covered', params: { number: choice.certificate.number, standard: choice.certificate.standard, date: choice.certificate.validTo } } : { key: 'sb.cert.missing' }
}

// ---- the ask ----------------------------------------------------------------------------------------------------------------------

export interface AskDraft {
  /** The choice's index in the answer. */
  choice: number | null
  lotId: string | null
  quantity: string
  reason: string
  note: string
}
export const blankAsk = (options: SubstituteOptions): AskDraft => {
  const first = options.choices.findIndex((choice) => choiceHeld(choice) === null)
  return { choice: first >= 0 ? first : null, lotId: null, quantity: '', reason: '', note: '' }
}

const DECIMAL = /^\d{1,8}([.,]\d{1,4})?$/
const decimal = (text: string): string | null => (DECIMAL.test(text.trim()) ? text.trim().replace(',', '.') : null)

/** Why "Ask for approval" waits, in words; null: it may go. */
export function askHeld(options: SubstituteOptions, draft: AskDraft, can: Pick<SubCan, 'ask'>, busy: boolean): Phrase | null {
  if (!can.ask) return { key: 'sb.held.noRight' }
  if (busy) return { key: 'sb.held.busy' }
  const choice = draft.choice === null ? null : options.choices[draft.choice]
  if (!choice) return { key: 'sb.held.pickChoice' }
  const held = choiceHeld(choice)
  if (held) return held
  const lot = draft.lotId ? choice.stock.lots.find((entry) => entry.lot?.id === draft.lotId) : null
  if (choice.kind === 'OWN_MATERIAL' && !lot) return { key: 'sb.held.pickLot' }
  if (lot && !lot.usable) return lotHeld(lot)
  const quantity = decimal(draft.quantity)
  if (quantity === null || Number(quantity) <= 0) return { key: 'sb.held.quantity', params: { uom: choice.item.baseUom } }
  if (choice.max !== null && Number(quantity) > Number(choice.max)) return { key: 'sb.held.tooMuch', params: { max: choice.max, uom: choice.item.baseUom } }
  if (lot && Number(quantity) > Number(lot.onHand)) return { key: 'sb.held.moreThanLot', params: { onHand: lot.onHand, uom: choice.item.baseUom } }
  if (draft.reason.trim() === '') return { key: 'sb.held.reason' }
  if (draft.reason.length > SUBSTITUTION_LIMITS.reason) return { key: 'sb.held.longReason', params: { max: SUBSTITUTION_LIMITS.reason } }
  if (draft.note.length > SUBSTITUTION_LIMITS.note) return { key: 'sb.held.longNote', params: { max: SUBSTITUTION_LIMITS.note } }
  return null
}

export function askBodyOf(options: SubstituteOptions, draft: AskDraft): AskBody {
  const choice = options.choices[draft.choice ?? 0]!
  return {
    workOrderId: options.workOrder.id,
    bomLineId: options.line.id,
    toItemId: choice.item.id,
    ...(draft.lotId ? { toLotId: draft.lotId } : {}),
    quantity: decimal(draft.quantity) ?? draft.quantity,
    uom: choice.item.baseUom,
    reason: draft.reason.trim(),
    ...(draft.note.trim() ? { note: draft.note.trim() } : {}),
  }
}

/** A refused ask or withdrawal in our words: the rule's code (409 refusal/<CODE>), a lot, a stale version, no right. */
export function askProblem(error: unknown): Phrase {
  if (!isApiError(error)) return { key: 'sb.failed' }
  const paths = error.issues.map(issuePath)
  const code = paths.find((path) => path.startsWith('refusal/'))?.split('/')[1]
  if (code) return { key: `sb.refusal.${code}` }
  if (paths.some((path) => path.includes('toLotId'))) return { key: 'sb.refusal.LOT_NOT_USABLE' }
  if (paths.some((path) => path.includes('quantity'))) return { key: 'sb.held.quantity', params: { uom: '' } }
  if (error.kind === 'conflict') return { key: 'sb.changed' }
  if (error.kind === 'forbidden' || error.kind === 'step_up') return { key: 'sb.held.noRight' }
  if (error.kind === 'unavailable') return { key: 'sb.offline' }
  return { key: 'sb.failed' }
}

/** A standing substitute may be withdrawn while it waits or is approved (inventory.issue). */
export const withdrawHeld = (substitution: Pick<Substitution, 'status'>, can: Pick<SubCan, 'ask'>): Phrase | null =>
  !can.ask ? { key: 'sb.held.noRight' } : substitution.status === 'WAITING' || substitution.status === 'APPROVED' ? null : { key: 'sb.held.final' }
