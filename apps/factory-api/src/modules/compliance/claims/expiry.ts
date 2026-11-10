import type { FactoryDatabase } from '@nexus/factory-db'
import { blockedSince } from '@nexus/factory-domain/compliance/claims/rules'
import { newId } from '@nexus/factory-domain/core/ids'
import { businessDate, type BusinessDate } from '@nexus/factory-domain/core/time'
import { callerFor, COMMAND_SETTINGS, runCommand, type CommandSettings } from '../../../core/command'
import { defineCron, type CronJob } from '../../../core/cron'
import type { Log } from '../../../core/queue'
import { serverClock, type Clock } from '../../../core/time'
import { activeTenants, asSystem, systemContext } from '../../../platform/outbox/system'
import { CLAIM_SELECT, evidenceFiles, stateOf, type ClaimRow } from './store'

/**
 * The claims' evidence check (B-W2b-264; PRD-380; design compliance.sourcing "live: claim.evidence_expired → Status column and
 * tile"; Dir. (EU) 2024/825), run daily by the scheduler's clustered cron `compliance.claimEvidenceExpiry` (00:25 Europe/Rome,
 * just after the business date turns; one replica per tick). For every ACTIVE tenant, in its system context, each APPROVED
 * claim whose evidence no longer holds (its last valid day passed, an evidence file expired or is gone) gets ONE
 * `claim.evidence_expired` event and an audit row on the claim, with how many places still use it. The command's
 * Idempotency-Key is fixed per claim and the day it stopped holding, so a race or a rerun says it once.
 *
 * Nothing changes on the claim: "blocked" is a reading (the list, the tiles and the gate compute it the same way), and a
 * person decides what follows (approve a replacement, end the uses). A run that skipped days catches up on the next one. A
 * claim or tenant that fails is logged and the others go on.
 */

export const EXPIRED_COMMAND = 'compliance.claims.evidenceExpired'

export interface ClaimExpiryOptions {
  readonly database: FactoryDatabase
  readonly log: Log
  readonly clock?: Clock
}

export interface ClaimExpiryRun {
  readonly tenants: number
  readonly today: BusinessDate
  readonly flagged: number
  readonly failed: number
}

/** One run over every active tenant (the cron's tick; tests call it directly). */
export async function runClaimEvidenceExpiry(options: ClaimExpiryOptions): Promise<ClaimExpiryRun> {
  const clock = options.clock ?? serverClock
  const settings: CommandSettings = { ...COMMAND_SETTINGS, clock }
  const today = businessDate(clock.now())
  const requestId = `claim-expiry-${newId()}`
  let flagged = 0
  let failed = 0
  const tenants = await activeTenants(options.database)
  for (const tenantId of tenants) {
    try {
      const caller = callerFor(options.database, systemContext(tenantId, requestId))
      const due = await asSystem(options.database, tenantId, requestId, async (client) => {
        const claims = (await client.sustainabilityClaim.findMany({ where: { status: 'APPROVED' }, orderBy: [{ id: 'asc' }], select: CLAIM_SELECT })) as ClaimRow[]
        const files = await evidenceFiles(client, claims.flatMap((claim) => claim.evidenceFileIds))
        const blocked = claims.map((claim) => ({ claim, ...stateOf(claim, files, today) })).filter((entry) => entry.state === 'BLOCKED')
        const uses = blocked.length > 0 ? await client.claimUse.groupBy({ by: ['claimId'], where: { claimId: { in: blocked.map((entry) => entry.claim.id) }, endedAt: null }, _count: { _all: true } }) : []
        return blocked.map((entry) => ({ ...entry, liveUses: uses.find((row) => row.claimId === entry.claim.id)?._count._all ?? 0 }))
      })
      for (const { claim, reasons, liveUses } of due) {
        const since = blockedSince(reasons) ?? today
        const causes = [...new Set(reasons.map((reason) => reason.cause))]
        try {
          const { replayed } = await runCommand(
            caller,
            { name: EXPIRED_COMMAND, idempotencyKey: `claim-evidence-expired:${claim.id}:${since}`, input: { claimId: claim.id, since } },
            async ({ audit, emit }) => {
              audit({ action: EXPIRED_COMMAND, recordType: 'SustainabilityClaim', recordId: claim.id, companyId: claim.companyId, after: { code: claim.code, since, causes, liveUses } })
              emit({ type: 'claim.evidence_expired', subject: claim.id, companyId: claim.companyId, payload: { claimId: claim.id, code: claim.code, since, causes, liveUses } })
              return { claimId: claim.id, since }
            },
            settings,
          )
          if (!replayed) flagged++
        } catch (error) {
          failed++
          options.log.error({ err: error, tenantId, claimId: claim.id }, 'a claim whose evidence expired could not be flagged')
        }
      }
    } catch (error) {
      failed++
      options.log.error({ err: error, tenantId }, 'the claims of a tenant could not be checked for expired evidence')
    }
  }
  const result = { tenants: tenants.length, today, flagged, failed }
  options.log.info({ ...result }, 'claim evidence checked')
  return result
}

/** The scheduler's daily cron (00:25 Europe/Rome). */
export function claimEvidenceExpiryCron(options: ClaimExpiryOptions): CronJob {
  return defineCron({
    name: 'compliance.claimEvidenceExpiry',
    schedule: '25 0 * * *',
    async run() {
      await runClaimEvidenceExpiry(options)
    },
  })
}
