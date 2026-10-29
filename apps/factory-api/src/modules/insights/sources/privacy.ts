import type { AttentionCandidate } from '@nexus/factory-domain/insights/attention'
import { privacySeverity } from '@nexus/factory-domain/insights/states'
import { privacyDutyWords } from '@nexus/factory-domain/insights/words'
import { privacyOverview } from '../../../platform/privacy/overview'
import type { Source } from './common'

/**
 * Privacy (B-W1-36): per company, the duties the privacy overview (GET /privacy/overview, "Your privacy duties") reads
 * from the records as not done: the record of processing activities, the public, staff and worker notices, the signed
 * DPIA. Missing the worker notice or the DPIA keeps floor work that records workers off: urgent.
 */

/** PRIVACY_DUTY: one row per company with a duty open. */
export const privacyDuty: Source = async ({ caller, viewer }) => {
  const overview = await privacyOverview(caller, {}, viewer.now)
  const open = overview.companies.filter((entry) => entry.duties.some((duty) => !duty.done))
  const since = await caller.withClient(async (db) =>
    new Map((await db.company.findMany({ where: { id: { in: open.map((entry) => entry.company.id) } }, select: { id: true, createdAt: true } })).map((row) => [row.id, row.createdAt])),
  )
  const candidates: AttentionCandidate[] = open.map((entry) => {
    const duties = entry.duties.filter((duty) => !duty.done).map((duty) => duty.key)
    return {
      kind: 'PRIVACY_DUTY',
      state: 'OPEN',
      severity: privacySeverity(duties),
      record: { type: 'Company', id: entry.company.id, label: entry.company.code },
      scope: { companyId: entry.company.id, siteId: null, partyId: null },
      ...privacyDutyWords({ company: entry.company.name, duties }),
      due: null,
      since: since.get(entry.company.id) ?? viewer.now,
      condition: duties,
    }
  })
  return { kind: 'PRIVACY_DUTY', candidates, complete: true }
}
