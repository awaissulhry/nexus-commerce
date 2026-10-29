import type { Prisma } from '@nexus/factory-db'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import type { AttentionCandidate } from '@nexus/factory-domain/insights/attention'
import { lotHoldWords } from '@nexus/factory-domain/insights/words'
import { QUALITY_LOTS_RELEASE, QUALITY_LOTS_REJECT, QUALITY_LOTS_VIEW } from '@nexus/factory-domain/quality/lab/permissions'
import { capped, SOURCE_LIMIT, type Source } from './common'

/**
 * Quality (B-W1-34 lab release): lots waiting in quarantine for their release, and lots blocked (a chromium VI result
 * that failed after release). A quarantined lot is released by a quality person who did not receive it (the lab
 * module's four eyes: Lot.createdById); a blocked one is rejected, or released again.
 */

/** LOT_HOLD: QUARANTINE and BLOCKED lots at the viewer's sites, oldest first. */
export const lotHold: Source = async ({ caller, viewer }) => {
  const scope = scopeWhere(viewer.actor, QUALITY_LOTS_VIEW, { company: 'companyId', site: 'siteId' }) as Prisma.LotWhereInput
  return caller.withClient(async (db) => {
    const found = await db.lot.findMany({
      where: { AND: [scope, { qualityStatus: { in: ['QUARANTINE', 'BLOCKED'] } }] },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: SOURCE_LIMIT + 1,
      select: { id: true, code: true, companyId: true, siteId: true, qualityStatus: true, crViStatus: true, receivedAt: true, qualityDecidedAt: true, createdAt: true, createdById: true, item: { select: { code: true, name: true } } },
    })
    const { rows, complete } = capped(found, SOURCE_LIMIT)
    const candidates: AttentionCandidate[] = rows.map((row) => {
      const state = row.qualityStatus === 'BLOCKED' ? 'BLOCKED' : 'QUARANTINE'
      return {
        kind: 'LOT_HOLD',
        state,
        severity: state === 'BLOCKED' ? 'HIGH' : 'MEDIUM',
        record: { type: 'Lot', id: row.id, label: row.code },
        scope: { companyId: row.companyId, siteId: row.siteId, partyId: null },
        ...lotHoldWords({ code: row.code, item: row.item.name, state, crViFail: row.crViStatus === 'FAIL' }),
        due: null,
        since: state === 'BLOCKED' ? (row.qualityDecidedAt ?? row.createdAt) : (row.receivedAt ?? row.createdAt),
        // A lot in quarantine is released (never by its receiver); a blocked one is rejected or released again.
        ...(state === 'QUARANTINE' ? { act: [QUALITY_LOTS_RELEASE], notBy: row.createdById ? [row.createdById] : [] } : { act: [QUALITY_LOTS_RELEASE, QUALITY_LOTS_REJECT] }),
      }
    })
    return { kind: 'LOT_HOLD', candidates, complete }
  })
}
