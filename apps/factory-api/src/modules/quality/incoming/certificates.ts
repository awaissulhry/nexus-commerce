import type { BusinessDate } from '@nexus/factory-domain/core/time'
import { businessDate } from '@nexus/factory-domain/core/time'
import type { CertificateFact } from '@nexus/factory-domain/quality/incoming/units'
import type { CommandCaller } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { asTenantSystem } from '../../production/bundles/codes'
import type { Inspector } from '../final/access'
import type { Reader } from './store'

/**
 * The certificates a component check is made against (B-W2b-111; QHS-033; EN 1621-1, -2): the PPE register's
 * (compliance.prisma Certificate, B-W1-12). A tablet reads no register (its grant has none): the bench's view and its
 * checks read them as the tenant's system caller, after the inspection's own access is checked — numbers, standards and
 * dates only, nothing personal.
 */

const COLUMNS = { id: true, number: true, standard: true, status: true, validFrom: true, validTo: true } as const
const dayOf = (value: Date): BusinessDate => value.toISOString().slice(0, 10)
const factOf = (row: { id: string; number: string; standard: string; status: string; validFrom: Date; validTo: Date }): CertificateFact => ({ id: row.id, number: row.number, standard: row.standard, status: row.status, validFrom: dayOf(row.validFrom), validTo: dayOf(row.validTo) })

export interface CertificateExtras {
  readonly today: BusinessDate
  /** Every certificate a row names, and the choices, by id. */
  readonly facts: ReadonlyMap<string, CertificateFact>
  /** The register's certificate covering the lot's item today (B-W1-12's rule), when the item has one. */
  readonly covering: CertificateFact | null
  /** EN 1621 certificates in force today, of the company or of a holder for every company (newest first, at most 50). */
  readonly choices: readonly CertificateFact[]
}

/** The facts of these certificates, read in the caller's own scope (a command's transaction, the office's client). */
export async function certificatesIn(db: Pick<Reader, 'certificate'>, ids: readonly string[]): Promise<Map<string, CertificateFact>> {
  const wanted = [...new Set(ids)]
  if (wanted.length === 0) return new Map()
  return new Map((await db.certificate.findMany({ where: { id: { in: wanted } }, select: COLUMNS })).map((row) => [row.id, factOf(row)]))
}

/** The certificates the record shows and the bench picks from (a tablet: read as the tenant's system caller). */
export async function certificateExtras(caller: CommandCaller, context: Inspector, input: { readonly companyId: string; readonly itemId: string | null; readonly named: readonly string[] }): Promise<CertificateExtras> {
  const today = businessDate(serverClock.now())
  const day = new Date(`${today}T00:00:00.000Z`)
  const reader = context.audience === 'floor' ? asTenantSystem(caller, context) : caller
  return reader.withClient(async (db) => {
    const choices = (
      await db.certificate.findMany({
        where: { status: 'VALID', validFrom: { lte: day }, validTo: { gte: day }, standard: { contains: '1621' }, OR: [{ companyId: null }, { companyId: input.companyId }] },
        select: COLUMNS,
        orderBy: [{ validTo: 'desc' }, { id: 'asc' }],
        take: 50,
      })
    ).map(factOf)
    let covering: CertificateFact | null = null
    if (input.itemId) {
      const coverage = await db.certificateCoverage.findMany({
        where: { itemId: input.itemId, status: 'ACTIVE', certificate: { status: 'VALID', validFrom: { lte: day }, validTo: { gte: day }, OR: [{ companyId: null }, { companyId: input.companyId }] } },
        select: { certificate: { select: COLUMNS } },
      })
      const best = coverage.map((row) => row.certificate).sort((a, b) => b.validTo.getTime() - a.validTo.getTime() || (a.id < b.id ? -1 : 1))[0]
      covering = best ? factOf(best) : null
    }
    const facts = await certificatesIn(db, input.named)
    for (const fact of [...choices, ...(covering ? [covering] : [])]) facts.set(fact.id, fact)
    return { today, facts, covering, choices }
  })
}
