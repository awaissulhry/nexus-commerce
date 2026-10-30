import { feeProblem, MAX_TRANSIT_DAYS } from '@nexus/factory-domain/product/routing/subcontract'
import type { RoutingStep, SubcontractPatch, WorkshopRow } from '../api'
import { decimalInput, editText, type Grains } from '../model'

/**
 * A routing step's subcontract details (W2a, PRD-120; design products.styles style.rt.grid "Subcontracted: supplier,
 * price per piece, transit days" and the operation's "Subcontract details"), pure. The workshop is a party with the
 * SUBCONTRACTOR role of the style's company or of every company (a style of every company: only a workshop of every
 * company); its fee per piece is the cost grain (absent without it: "Not in your role", and never sent); the transit
 * days are the days the pieces travel there and back (0 … 365). Another workshop starts with no fee and no days unless
 * they are given (factory-domain planSubcontract).
 */

export interface SubcontractDraft {
  /** in: done in-house; out: done by a workshop. */
  mode: 'in' | 'out'
  supplierId: string
  /** As typed, either decimal sign; '' = agreed per order. */
  fee: string
  /** As typed; '' = not set. */
  days: string
}

export const subcontractDraftOf = (step: Pick<RoutingStep, 'subcontract'>, locale: 'it' | 'en'): SubcontractDraft => ({
  mode: step.subcontract ? 'out' : 'in',
  supplierId: step.subcontract?.supplier.id ?? '',
  fee: editText(step.subcontract?.pricePerPiece ?? null, locale),
  days: step.subcontract?.transitDays === null || step.subcontract?.transitDays === undefined ? '' : String(step.subcontract.transitDays),
})

/** The workshops a step of this style may name (the API's rule), the step's own kept first even when it no longer fits. */
export function workshopsFor(workshops: readonly WorkshopRow[], styleCompanyId: string | null): WorkshopRow[] {
  return workshops.filter((workshop) => workshop.companyId === null || (styleCompanyId !== null && workshop.companyId === styleCompanyId))
}

export const workshopName = (workshop: Pick<WorkshopRow, 'tradeName' | 'legalName'>): string => workshop.tradeName ?? workshop.legalName

/** Each field's problem (a message key of `products`). */
export function subcontractProblems(draft: SubcontractDraft, grains: Pick<Grains, 'cost'>): Partial<Record<'supplierId' | 'fee' | 'days', string>> {
  const problems: Partial<Record<'supplierId' | 'fee' | 'days', string>> = {}
  if (draft.mode === 'in') return problems
  if (!draft.supplierId) problems.supplierId = 'subcontract.problem.workshop'
  if (grains.cost && draft.fee.trim() !== '') {
    const fee = decimalInput(draft.fee, 6)
    if (fee === undefined || fee === null || feeProblem(fee)) problems.fee = 'subcontract.problem.fee'
  }
  if (draft.days.trim() !== '') {
    const days = Number(draft.days.trim())
    if (!/^\d+$/.test(draft.days.trim()) || days > MAX_TRANSIT_DAYS) problems.days = 'subcontract.problem.days'
  }
  return problems
}

/**
 * What the step's PATCH sends: null (back in-house), else only what changed — the workshop when it is another one, the
 * fee only with the cost grain, the days. Undefined: nothing changed.
 */
export function subcontractPatch(step: Pick<RoutingStep, 'subcontract'>, draft: SubcontractDraft, grains: Pick<Grains, 'cost'>): SubcontractPatch | null | undefined {
  const current = step.subcontract
  if (draft.mode === 'in') return current ? null : undefined
  const patch: SubcontractPatch = {}
  const sameWorkshop = current?.supplier.id === draft.supplierId
  if (!sameWorkshop) patch.supplierId = draft.supplierId
  if (grains.cost) {
    const fee = draft.fee.trim() === '' ? null : (decimalInput(draft.fee, 6) ?? null)
    const before = sameWorkshop ? (current?.pricePerPiece ?? null) : null
    const same = fee === null ? before === null : before !== null && Number(before) === Number(fee)
    if (!same || !sameWorkshop) {
      if (fee !== null || before !== null) patch.pricePerPiece = fee
    }
  }
  const days = draft.days.trim() === '' ? null : Number(draft.days.trim())
  const beforeDays = sameWorkshop ? (current?.transitDays ?? null) : null
  if (days !== beforeDays) patch.transitDays = days
  return Object.keys(patch).length === 0 ? undefined : patch
}
