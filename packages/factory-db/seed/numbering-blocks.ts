import { DEVICE_BLOCK_SIZE, nextRange, scanCodes } from '@nexus/factory-domain/numbering/blocks'
import { SCAN_ID_KINDS } from '@nexus/factory-domain/numbering/kinds'
import type { Prisma } from '../src/generated/prisma/client'
import { seedUuid, type SeedContext } from '../src/seeding'

/**
 * The floor numbering seed: each seeded tablet (seed/floor-auth.ts: the cutting tablets of plants A1 and B1) holds one
 * block of every scan-id kind (BUNDLE, HIDE, GARMENT_SERIAL; the tenant's counter runs A1's block, then B1's), and two
 * hide tags of A1's block and one of B1's are used, for made-up hides. A separate file from seed/numbering.ts because a
 * block needs its tablet: it runs after seed/floor-auth.ts (seeds run in name order), and the tests that seed only the
 * document series need no tablet.
 *
 * Written in the tenant's office scope, as the app writes it. A block starts above every block before it (the guard
 * trigger runs before ON CONFLICT), so a second run inserts only the rows that are missing. B1's rows have ids that
 * start with eight f's (still derived from the namespace), so A1's rows sort first: those are the ones the generated
 * isolation tests copy, inside the floor scope of plant A1.
 */

const SEEDED_AT = new Date('2026-10-28T08:00:00.000Z')
const USED_AT = new Date('2026-10-28T09:00:00.000Z')
const REQUEST = 'seed-numbering-blocks'

export async function seed({ db, namespace }: SeedContext): Promise<void> {
  const id = (key: string): string => seedUuid(namespace, key)
  const late = (key: string): string => `ffffffff${id(key).slice(8)}`
  const tenantId = id('tenant')
  const actorId = id('actor')
  const tablets = [
    { plant: 'A1', siteId: id('site:A1'), deviceId: id('device:A1:cutting'), rowId: id },
    { plant: 'B1', siteId: id('site:B1'), deviceId: id('device:B1:cutting'), rowId: late },
  ]

  const blocks: Prisma.NumberBlockCreateManyInput[] = []
  const uses: Prisma.NumberBlockUseCreateManyInput[] = []
  for (const kind of SCAN_ID_KINDS) {
    let highest: number | null = null
    for (const tablet of tablets) {
      const range = nextRange(highest, DEVICE_BLOCK_SIZE[kind])
      highest = range.toRef
      const blockId = tablet.rowId(`number-block:${tablet.plant}:${kind}`)
      blocks.push({ id: blockId, kind, purpose: 'DEVICE', ...range, deviceId: tablet.deviceId, requestId: REQUEST, createdAt: SEEDED_AT, updatedAt: SEEDED_AT })
      if (kind !== 'HIDE') continue
      const used = tablet.plant === 'A1' ? 2 : 1
      scanCodes(tenantId, kind, { fromRef: range.fromRef, toRef: range.fromRef + used - 1 }).forEach((code, index) => {
        uses.push({
          id: tablet.rowId(`number-block-use:${tablet.plant}:${kind}:${index + 1}`),
          siteId: tablet.siteId,
          deviceId: tablet.deviceId,
          blockId,
          kind,
          ref: range.fromRef + index,
          code,
          recordType: 'Hide',
          recordId: id(`hide:${tablet.plant}:tagged:${index + 1}`),
          usedAt: USED_AT,
          requestId: REQUEST,
        })
      })
    }
  }

  await db.withScope({ audience: 'office', tenantId, actorId }, (client) =>
    client.$transaction(async (tx) => {
      const present = new Set((await tx.numberBlock.findMany({ where: { id: { in: blocks.map((block) => block.id!) } }, select: { id: true } })).map((row) => row.id))
      // One at a time, in counter order: each block starts above the ones before it.
      for (const block of blocks) if (!present.has(block.id!)) await tx.numberBlock.create({ data: block, select: { id: true } })
      await tx.numberBlockUse.createMany({ data: uses, skipDuplicates: true })
    }),
  )
}
