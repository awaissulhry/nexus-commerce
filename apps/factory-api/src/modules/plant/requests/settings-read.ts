import { holds } from '@nexus/factory-domain/core/permissions'
import { H1_SETTINGS, type LockBy, type Locker, type LockSettings, type SignSafeBy } from '@nexus/factory-domain/plant/requests/lock'
import { PLANT_JOBS_WORK, PLANT_REQUESTS_TRIAGE } from '@nexus/factory-domain/plant/permissions'
import type { CommandTx } from '../../../core/command'
import { actorOf } from '../../../core/context'
import type { PlantContext } from '../access'

/**
 * A site's unsafe-lock settings as every plant command reads them (B-W2b-96; QHS-183): the PlantSettings row whose id is the
 * site's, else Owner answer H1's defaults (anyone at the station locks, only a technician signs safe, a hazard report on
 * lock). The floor reads its own site's row (its grant), the office any site it reaches.
 */
export async function lockSettingsOf(db: Pick<CommandTx, 'plantSettings'>, siteId: string): Promise<LockSettings & { readonly version: number | null }> {
  const row = await db.plantSettings.findUnique({ where: { id: siteId }, select: { lockBy: true, signSafeBy: true, hazardReportOnLock: true, version: true } })
  return row ? { lockBy: row.lockBy as LockBy, signSafeBy: row.signSafeBy as SignSafeBy, hazardReportOnLock: row.hazardReportOnLock, version: row.version } : { ...H1_SETTINGS, version: null }
}

/** Who is locking, for the lock rule: a line lead (floor.lead; the office's triage) or a technician (plant.jobs.work). */
export function lockerOf(context: PlantContext): Locker {
  const actor = actorOf(context)
  return { lead: context.audience === 'floor' ? holds(actor, 'floor.lead') : holds(actor, PLANT_REQUESTS_TRIAGE), technician: holds(actor, PLANT_JOBS_WORK) }
}
