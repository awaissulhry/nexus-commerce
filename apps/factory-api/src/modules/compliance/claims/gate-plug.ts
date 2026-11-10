import type { CheckResult } from '@nexus/factory-domain/compliance/gates/gate'
import { blockedSince, VALIDITY_THRESHOLDS, validityOf } from '@nexus/factory-domain/compliance/claims/rules'
import type { BusinessDate } from '@nexus/factory-domain/core/time'
import { plugGateCheck } from '../gates/plugs'
import { CLAIM_SELECT, dayOf, evidenceFiles, stateOf, type ClaimRow, type Reader } from './store'

/**
 * The claims register plugged into the one compliance gate by name (B-W2b-264 on B-W2b-254's `plugGateCheck`): a requirement
 * whose checkKey is `claims.evidence` (B-W2b-222's seeded CLAIM-EVIDENCE, kind CLAIM_EVIDENCE, blocking LABEL_PRINT) asks
 * whether every sustainability claim still used on the style or on the label the gate reads is approved with evidence that
 * holds today (Dir. (EU) 2024/825: a claim needs its evidence). The requirement is switched OFF until a style or a market needs
 * green claims (Owner answer 11-09, Q23 / Q5 = A): only an ACTIVE requirement that is ON is ever computed, so this check
 * refuses nothing until the Owner switches it on (Rules & markets › Gates).
 *
 *   no claim used there      NOT_NEEDED
 *   every claim holds        PRESENT (EXPIRING when one ends within 30 days: shown, never refusing)
 *   one no longer holds      MISSING: its code, why (its last valid day, an evidence file expired or gone, withdrawn), and
 *                            the fix (approve a replacement with valid evidence, or end its use there)
 *
 * The answer is the style's and its label's, the same for every colourway, size and market of the question.
 */

export const CLAIM_CHECK_KEY = 'claims.evidence'

const FIX = 'approve a replacement with valid evidence, or end the claim\'s use there (Compliance › Sourcing & claims).'

/** What the gate says of the claims used on one style and its label, today. */
export async function claimsCheck(db: Reader, styleId: string, labelTemplateId: string | null, day: BusinessDate): Promise<CheckResult> {
  const records = [{ recordType: 'Style', recordId: styleId }, ...(labelTemplateId ? [{ recordType: 'LabelTemplate', recordId: labelTemplateId }] : [])]
  const uses = await db.claimUse.findMany({ where: { endedAt: null, OR: records }, select: { claimId: true, recordType: true } })
  if (uses.length === 0) return { state: 'NOT_NEEDED', message: 'No sustainability claim is used on this style or its label.', fix: null, facts: { code: 'claims.none' }, evidence: null }
  const claims = (await db.sustainabilityClaim.findMany({ where: { id: { in: [...new Set(uses.map((use) => use.claimId))] } }, orderBy: [{ code: 'asc' }, { id: 'asc' }], select: CLAIM_SELECT })) as ClaimRow[]
  const files = await evidenceFiles(db, claims.flatMap((claim) => claim.evidenceFileIds))
  const where = (claimId: string) => (uses.some((use) => use.claimId === claimId && use.recordType === 'LabelTemplate') ? 'label' : 'style')
  for (const claim of claims) {
    const { state, reasons } = stateOf(claim, files, day)
    if (state === 'APPROVED') continue
    const facts = { code: 'claims.notHolding', claim: claim.code, state, since: blockedSince(reasons), causes: reasons.map((reason) => reason.cause) }
    const why =
      state === 'RETIRED' ? 'it was withdrawn' : state === 'DRAFT' ? 'it is not approved' : reasons[0]?.cause === 'VALID_UNTIL' ? `its evidence held until ${dayOf(claim.validUntil)}` : reasons[0]?.cause === 'FILE_EXPIRED' ? `an evidence file expired on ${reasons[0].day}` : 'an evidence file is no longer there'
    return { state: 'MISSING', message: `Sustainability claim ${claim.code} is still used on this ${where(claim.id)}, but ${why}.`, fix: FIX, facts, evidence: null }
  }
  const first = claims[0]!
  const soonest = claims.map((claim) => ({ claim, validity: validityOf(dayOf(claim.validUntil), day) })).filter((entry) => entry.validity.state === 'SOON' && (entry.validity.daysLeft ?? Infinity) <= VALIDITY_THRESHOLDS[2])[0]
  const evidence = { recordType: 'SustainabilityClaim', recordId: (soonest?.claim ?? first).id, label: (soonest?.claim ?? first).code }
  if (soonest) return { state: 'EXPIRING', message: `Sustainability claim ${soonest.claim.code} holds until ${dayOf(soonest.claim.validUntil)}.`, fix: null, facts: { code: 'claims.expiring', claim: soonest.claim.code, daysLeft: soonest.validity.daysLeft }, evidence }
  return { state: 'PRESENT', message: `Every sustainability claim used here is approved with evidence that holds (${claims.map((claim) => claim.code).join(', ')}).`, fix: null, facts: { code: 'claims.holding', claims: claims.map((claim) => claim.code) }, evidence }
}

plugGateCheck([CLAIM_CHECK_KEY], { kinds: ['CLAIM_EVIDENCE'], market: false, who: 'COMPLIANCE', fix: 'requirements' }, async (context) => {
  const result = await claimsCheck(context.db, context.style.row.id, context.labelTemplateId, context.day)
  return () => result
})
