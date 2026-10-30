import { BASE_REASONS } from '@nexus/factory-domain/reasons/standard'
import type { ReasonCodeList } from '@nexus/factory-domain/reasons/lists'
import { seedUuid, type SeedContext } from '../src/seeding'

/**
 * The reason lists seed (B-W2a-18's table), per tenant of seed/_core.ts: factory-domain's standard reasons
 * (reasons/standard.ts BASE_REASONS, which the API also gives a new tenant) for every ReasonList, in Italian and English,
 * with an icon of the design system's tag set and one of its swatches, an "Other" reason that asks for a note (office)
 * or a photo (floor) where a list needs one. The operation screen's scrap and rework reasons stay in ScrapReason
 * (seed/production.ts) and the defect library comes with wave 6/7; one editor edits them all (platform/reasons).
 * Made-up wording a factory edits; written in the tenant's office scope; idempotent (stable ids, upserts that leave a
 * code as it is: a code never changes).
 */

const AT = new Date('2026-10-30T08:00:00.000Z')

export async function seed({ db, namespace }: SeedContext): Promise<void> {
  const id = (key: string): string => seedUuid(namespace, key)
  const tenantId = id('tenant')
  const actorId = id('actor')

  await db.withScope({ audience: 'office', tenantId, actorId }, (client) =>
    client.$transaction(async (tx) => {
      for (const [list, reasons] of Object.entries(BASE_REASONS) as [ReasonCodeList, (typeof BASE_REASONS)[ReasonCodeList]][]) {
        for (const [order, { code, labelIt, labelEn, icon, colour, needsDetail }] of reasons.entries()) {
          const reasonId = id(`reasons:${list}:${code}`)
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
