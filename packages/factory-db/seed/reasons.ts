import { BASE_REASONS } from '@nexus/factory-domain/reasons/standard'
import type { ReasonCodeList } from '@nexus/factory-domain/reasons/lists'
import { seedUuid, takenBy, type SeedContext } from '../src/seeding'

/**
 * The reason lists seed (B-W2a-18's table), per tenant of seed/_core.ts: factory-domain's standard reasons
 * (reasons/standard.ts BASE_REASONS, which the API also gives a new tenant) for every ReasonList, in Italian and English,
 * with an icon of the design system's tag set and one of its swatches, an "Other" reason that asks for a note (office)
 * or a photo (floor) where a list needs one. The operation screen's scrap and rework reasons stay in ScrapReason
 * (seed/production.ts) and the defect library comes with wave 6/7; one editor edits them all (platform/reasons).
 * Made-up wording a factory edits; written in the tenant's office scope; idempotent (stable ids, upserts that leave a
 * code as it is: a code never changes).
 * B-W2b-GS1: also on a tenant the app has used: the API gives a list that is EMPTY its standard reasons (the worker's start
 * and a daily cron), with ids of its own, so a list may hold the seed's codes already; a code is unique in its list. Such a
 * reason is the tenant's (perhaps edited since): the seed leaves it exactly as it is and writes only its own rows.
 * B-PR-15 (production plan, schema wave 3/5): the PRODUCTION_HOLD list (why a work order is on a plain production hold) comes
 * with BASE_REASONS like every other list, so it is seeded here too.
 */

const AT = new Date('2026-10-30T08:00:00.000Z')

export async function seed({ db, namespace }: SeedContext): Promise<void> {
  const id = (key: string): string => seedUuid(namespace, key)
  const tenantId = id('tenant')
  const actorId = id('actor')

  await db.withScope({ audience: 'office', tenantId, actorId }, (client) =>
    client.$transaction(async (tx) => {
      const lists = Object.entries(BASE_REASONS) as [ReasonCodeList, (typeof BASE_REASONS)[ReasonCodeList]][]
      const wanted = lists.flatMap(([list, reasons]) => reasons.map(({ code }) => ({ id: id(`reasons:${list}:${code}`), list, code })))
      const taken = takenBy(wanted, await tx.reasonCode.findMany({ select: { id: true, list: true, code: true } }), (row) => `${row.list}:${row.code}`)
      for (const [list, reasons] of lists) {
        for (const [order, { code, labelIt, labelEn, icon, colour, needsDetail }] of reasons.entries()) {
          const reasonId = id(`reasons:${list}:${code}`)
          if (taken.has(reasonId)) continue
          const words = { labelIt, labelEn, icon, colour, needsDetail, sortOrder: (order + 1) * 10 }
          await tx.reasonCode.upsert({
            where: { id: reasonId },
            create: { id: reasonId, list, code, ...words, createdAt: AT, updatedAt: AT, createdById: actorId },
            update: words,
            select: { id: true },
          })
        }
      }
    }),
  )
}
