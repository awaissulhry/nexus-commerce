import { z } from 'zod'
import { DEPTH_LIMITS, photosNeeded } from '@nexus/factory-domain/sales/repairs-depth/rules'
import { issuePath, type ApiIssue } from '../../../../lib/api/errors'
import type { ClaimItem, ClaimPage } from '../../api'
import type { Problem } from '../../model'
import { REPAIR_KINDS, type RepairBody, type RepairKind } from './api'

/**
 * SCR-197 › Repair or alteration (B-W2b-342; follow-ups RR1:01 "The claim link offers Repair with its questions and damage
 * photos", RR1:02; design links.claim sec:type "Repair or alteration", sec:item "Item list from the order · size · serial:
 * scan the label (camera) or type", sec:details "Repair: the work wanted ('add 2 cm to the sleeve') — no payment data here",
 * sec:photos "at least 2 for damage"): the repair's part of the claim form, pure. The garment is an item of the shipment or
 * order, or another garment named by the serial on its label; a repair says what is wrong (the work wanted may add to it),
 * an alteration the work wanted; a repair asks two damage photos, an alteration's fit photos are optional.
 */

/** A garment that is not in this delivery: named by its serial only. */
export const OTHER_GARMENT = '+'

export interface RepairForm {
  kind: RepairKind
  /** An item's key, OTHER_GARMENT, or none yet. */
  itemKey: string | null
  serial: string
  problem: string
  workWanted: string
}

export const EMPTY_REPAIR: RepairForm = Object.freeze({ kind: 'REPAIR', itemKey: null, serial: '', problem: '', workWanted: '' }) as RepairForm

export const REPAIR_LIMITS = Object.freeze({ serial: DEPTH_LIMITS.serial, problem: DEPTH_LIMITS.problem, workWanted: DEPTH_LIMITS.workWanted })

const blank = (value: string): boolean => value.trim() === ''
const tooLong = (value: string, max: number): boolean => value.trim().length > max
const trimmed = (value: string): string | null => (blank(value) ? null : value.trim())

/** The items a repair may name: one garment of an order line (each line once). */
export function repairItems(page: Pick<ClaimPage, 'items'>): ClaimItem[] {
  const seen = new Set<string>()
  return page.items.filter((item) => item.salesOrderLineId !== null && !seen.has(item.key) && (seen.add(item.key), true))
}

export const repairItemOf = (page: Pick<ClaimPage, 'items'>, key: string | null): ClaimItem | null => (key && key !== OTHER_GARMENT ? (repairItems(page).find((item) => item.key === key) ?? null) : null)

/** Photos the repair asks (two for a damage; an alteration's are optional). */
export const repairPhotosNeeded = (form: Pick<RepairForm, 'kind'>): number => photosNeeded(form.kind)

/** The repair's problems, step by step, field by field (the API checks the same again). Fields: `repair.<field>`. */
export function repairProblems(form: RepairForm, page: Pick<ClaimPage, 'items'>): Problem[] {
  const problems: Problem[] = []
  const items = repairItems(page)
  if (form.itemKey === null || (form.itemKey !== OTHER_GARMENT && !items.some((item) => item.key === form.itemKey))) problems.push({ step: 'item', field: 'repair.item', key: 'returns-repair:check.item' })
  if (form.itemKey === OTHER_GARMENT && blank(form.serial)) problems.push({ step: 'item', field: 'repair.serial', key: 'returns-repair:check.serial' })
  if (tooLong(form.serial, REPAIR_LIMITS.serial)) problems.push({ step: 'item', field: 'repair.serial', key: 'returns-repair:check.long', params: { max: REPAIR_LIMITS.serial } })
  if (form.kind === 'REPAIR' && blank(form.problem)) problems.push({ step: 'details', field: 'repair.problem', key: 'returns-repair:check.problem' })
  if (tooLong(form.problem, REPAIR_LIMITS.problem)) problems.push({ step: 'details', field: 'repair.problem', key: 'returns-repair:check.long', params: { max: REPAIR_LIMITS.problem } })
  if (form.kind === 'ALTERATION' && blank(form.workWanted)) problems.push({ step: 'details', field: 'repair.workWanted', key: 'returns-repair:check.workWanted' })
  if (tooLong(form.workWanted, REPAIR_LIMITS.workWanted)) problems.push({ step: 'details', field: 'repair.workWanted', key: 'returns-repair:check.long', params: { max: REPAIR_LIMITS.workWanted } })
  return problems
}

/** The body POST /link/claim/repair takes (call it once the problems are none). */
export function repairBodyOf(form: RepairForm, page: Pick<ClaimPage, 'items'>, typedName: string): RepairBody {
  const item = repairItemOf(page, form.itemKey)
  return {
    kind: form.kind,
    salesOrderLineId: item?.salesOrderLineId ?? null,
    size: item?.size ?? null,
    serial: trimmed(form.serial),
    problem: trimmed(form.problem),
    workWanted: trimmed(form.workWanted),
    typedName: trimmed(typedName),
  }
}

/** Where an issue of the API's refusal of a repair belongs, in this page's words. */
export function repairIssueProblem(issue: ApiIssue): Problem {
  const path = issuePath(issue).replace(/\./g, '/')
  if (path === 'body/salesOrderLineId' || path === 'body/size') return { step: 'item', field: 'repair.item', key: 'returns-repair:check.item' }
  if (path === 'body/serial') return { step: 'item', field: 'repair.serial', key: 'returns-repair:refusal.serial' }
  if (path === 'body/problem') return { step: 'details', field: 'repair.problem', key: 'returns-repair:check.problem' }
  if (path === 'body/workWanted') return { step: 'details', field: 'repair.workWanted', key: 'returns-repair:check.workWanted' }
  if (path === 'body/typedName') return { step: 'review', field: 'typedName', key: 'refusal.field' }
  return { step: 'review', field: 'send', key: 'refusal.field' }
}

// ---- the draft kept with us ---------------------------------------------------------------------------------------------

export const repairDraftSchema = z.object({
  kind: z.enum(REPAIR_KINDS),
  itemKey: z.string().max(200).nullable(),
  serial: z.string().max(400),
  problem: z.string().max(8000),
  workWanted: z.string().max(8000),
})

/** A draft's repair made to fit the page as it is now (an item gone is cleared). */
export function repairFromDraft(saved: z.infer<typeof repairDraftSchema> | undefined, page: Pick<ClaimPage, 'items'>): RepairForm {
  if (!saved) return { ...EMPTY_REPAIR }
  const itemKey = saved.itemKey === OTHER_GARMENT || repairItems(page).some((item) => item.key === saved.itemKey) ? saved.itemKey : null
  return { ...saved, itemKey }
}

/** A repair's next step for the customer in this page's words (`common.next.<CODE>` of returns-repair). */
export const repairNextKey = (code: string): string => `common.next.${code}`
export const repairStageKey = (stage: string): string => `common.stage.${stage}`

export { REPAIR_KINDS }
