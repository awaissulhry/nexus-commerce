import { randomUUID } from 'node:crypto'

/**
 * The PERFORMANCE legal gate for a test of an office read (B-W2b-F3): `switchOnPerformance` writes the site's gate row, made up,
 * and answers the switch-off, so a test reads with the gate off, on, and off again. The notice and the impact assessment are
 * another step's (B-W2b-27 tests them): the row is written as the replication role, so a world without the privacy seed can
 * use it too. Test databases only.
 */

type Admin = (sql: string, params?: unknown[]) => Promise<unknown>

export interface GatePlace {
  readonly tenantId: string
  readonly companyId: string
  readonly siteId: string
  /** Any id: the person on the made-up record. */
  readonly byId: string
}

export async function switchOnPerformance(admin: Admin, place: GatePlace): Promise<() => Promise<void>> {
  const id = randomUUID()
  await admin(
    `BEGIN;
     SET LOCAL session_replication_role = replica;
     INSERT INTO "PeopleLegalGate" (id, "tenantId", "companyId", "siteId", purpose, basis, "basisReference", "noticeId", "dpiaId", "switchedOnAt", "switchedOnById", "updatedAt")
     VALUES ('${id}', '${place.tenantId}', '${place.companyId}', '${place.siteId}', 'PERFORMANCE', 'UNION_AGREEMENT', 'SAMPLE - made-up basis for the test', '${randomUUID()}', '${randomUUID()}', now() - interval '1 minute', '${place.byId}', now());
     COMMIT`,
  )
  return async () => {
    await admin(`UPDATE "PeopleLegalGate" SET "switchedOffAt" = now(), "switchedOffById" = $2, "switchOffReason" = 'The test is over.', "updatedAt" = now() WHERE id = $1`, [id, place.byId])
  }
}
