import type { BusinessDate } from '@nexus/factory-domain/core/time'
import { qualificationsFor } from '../../purchasing/qualification/qualifications'
import type { Reader } from '../store'

/**
 * Only approved workshops in the plan's proposals (B-W2b-321; PLN-162; B-W2b-293's gap "workshop qualification is not read
 * by proposals"): for each revision and workshop its routing names, why the workshop may not get those steps (B-W2b-315's
 * qualification by kind of work or library operation); none: it may. modules/planning/planned-orders/pass.ts asks it, so
 * a run proposes a planned SUBCONTRACT order only to a qualified workshop (the others stay MAKE with the words said).
 */
export async function unqualifiedWorkshops(
  db: Reader,
  companyId: string,
  steps: readonly { readonly revisionId: string; readonly seq: number; readonly supplierId: string | null; readonly workCentreKind: string; readonly operationId: string }[],
  today: BusinessDate,
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const outside = steps.filter((step) => step.supplierId !== null)
  const asked = new Map<string, { kind: string; operationId: string; partyIds: Set<string> }>()
  for (const step of outside) {
    const key = `${step.workCentreKind}|${step.operationId}`
    const entry = asked.get(key) ?? { kind: step.workCentreKind, operationId: step.operationId, partyIds: new Set<string>() }
    entry.partyIds.add(step.supplierId!)
    asked.set(key, entry)
  }
  const answers = new Map<string, { qualified: boolean; words: string }>()
  for (const [key, entry] of asked) {
    const result = await qualificationsFor(db, { companyId, partyIds: [...entry.partyIds], need: { workCentreKind: entry.kind as never, operationId: entry.operationId }, today })
    for (const [partyId, answer] of result) answers.set(`${key}|${partyId}`, answer)
  }
  for (const step of outside) {
    const answer = answers.get(`${step.workCentreKind}|${step.operationId}|${step.supplierId}`)
    const key = `${step.revisionId}|${step.supplierId}`
    if (answer && !answer.qualified && !out.has(key)) out.set(key, `Not approved for ${step.workCentreKind.toLowerCase()} (step ${step.seq}): ${answer.words.charAt(0).toLowerCase()}${answer.words.slice(1)}`)
  }
  return out
}
