import { seedUuid, type SeedContext } from '../src/seeding'
import { seed as seedPortalFollowups } from './portal-followups'
import { seed as seedReasons } from './reasons'

/**
 * The W2b-5 follow-ups for sales, buying and approvals (W2b-6 schema wave 45/57, B-W2b-363), per tenant of seed/_core.ts,
 * written in the tenant's office scope as the app writes them. It sorts after reasons.ts and portal-followups.ts and runs
 * them first anyway (both idempotent). Every word is made up.
 *
 *   reason groups    the standard RETURN reasons reported by group (B-W2b-380 reads them): WRONG_SIZE under "Taglia",
 *                    DEFECT under "Qualità", DAMAGED_IN_TRANSIT and WRONG_ITEM under "Spedizione"; OTHER stays on its own.
 *   document type    P2's accepted LWG certificate (seed/portal-followups.ts) is an LWG_AUDIT of the SUPPLIER_DOCUMENT_TYPE
 *                    reasons (B-W2b-377's vault reads it).
 *
 * The other new columns stay null on the seeded rows: no option group takes a colour or a material (B-W2b-340's tests pick
 * both on the seed's groups), no receipt line is held, no fee line credited, no photo has a delete date, the purchasing
 * settings keep W2a's confirm-by and cadence; no RMA asks a remake.
 *
 * Idempotent: a group or a type is written only where none is set.
 */

const RETURN_GROUPS: Readonly<Record<string, string>> = Object.freeze({
  WRONG_SIZE: 'Taglia',
  DEFECT: 'Qualità',
  DAMAGED_IN_TRANSIT: 'Spedizione',
  WRONG_ITEM: 'Spedizione',
})

export async function seed(context: SeedContext): Promise<void> {
  const { db, namespace } = context
  await seedReasons(context)
  const portal = await seedPortalFollowups(context)
  const id = (key: string): string => seedUuid(namespace, key)
  const tenantId = id('tenant')
  const actorId = id('actor')

  await db.withScope({ audience: 'office', tenantId, actorId }, (client) =>
    client.$transaction(async (tx) => {
      for (const [code, group] of Object.entries(RETURN_GROUPS)) {
        await tx.reasonCode.updateMany({ where: { list: 'RETURN', code, group: null }, data: { group } })
      }
      await tx.storedFile.updateMany({ where: { id: portal.files.certificate, documentTypeCode: null }, data: { documentTypeCode: 'LWG_AUDIT' } })
    }),
  )
}
