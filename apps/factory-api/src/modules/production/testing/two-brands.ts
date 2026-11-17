import type { FastifyInstance } from 'fastify'
import type { FactoryDatabase } from '@nexus/factory-db'
import type { MigratedDatabase } from '@nexus/factory-db/testing'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
// The factory-db fixtures and seeds are no package export: a test reads them where they live.
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { seedSecondBrand, type SecondBrand } from '../../../../../../packages/factory-db/src/testing/second-brand'
import type { SessionContext } from '../../../core/context'
import { findMarkers, recordMarkers, type Marker } from '../../../golden-flow/portal/testing/two-brands'
import type { World } from '../../../golden-flow/testing/world'

/**
 * B-PR-03 (production plan §2 "Proof", 08-backend §1.5; Owner rule 2026-11-16: "One brand must not be able to see anything
 * related to any other brand. But we, as the production unit, should be able to see it all. And manage it all as well."): TWO
 * CUSTOMERS IN PRODUCTION, for every production wall test (PW-xx). It IMPORTS the threads plan's two-brand fixtures and adds only
 * production rows:
 *
 *   - brand A = the seeds' customer P1 ("the one whose data must never show"); brand B = the threads' second brand of the same
 *     tenant (factory-db src/testing/second-brand.ts, B-TH-001: party SEED-C2B and its order SEED-SO-B001), the reader;
 *   - a style of our own collection (a copy of the production seed's SEED-JKT-02 with no brand: the seed's styles are P1's
 *     private label, which another customer never orders), its BLK colourway and released revision 1;
 *   - per brand an order line of it (A: a new CONFIRMED order; B: a line on SEED-SO-B001) and a DRAFT work order of two of its
 *     cells, made through the real route as `office.all`;
 *   - one MIXED work order made before the one-customer rule (B-PR-01): a cell of each brand, no customer; written by the
 *     test's admin pool with the database's rules off for that one statement (as the copy step found such work orders);
 *   - the sessions `office.all` (every customer), `office.p1` and `office.p2` (a grant limited to that customer);
 *   - `markersOf`: everything of a brand that must never reach the other — the threads' record markers (golden-flow portal
 *     testing/two-brands.ts recordMarkers: names, codes, numbers, references, file names, ids) and its work orders' numbers,
 *     batch numbers and ids; `findMarkers` (theirs) scans an answer for them.
 *
 * Needs the core, files, production and numbering seeds of the namespace first, and an app whose test authenticator knows
 * `office.all` (twoBrandSessions). Every name, address and number is invented (`example.com`; no real company).
 */

/** The made-up style of our own collection both brands order (its code names no customer). */
export const OWN_STYLE_CODE = 'T-OWN-JKT-02'

export interface BrandInProduction {
  readonly partyId: string
  readonly salesOrderId: string
  readonly salesOrderLineId: string
  readonly workOrderId: string
  readonly workOrderNumber: string
}

export interface ProductionTwoBrands {
  readonly tenantId: string
  readonly companyId: string
  readonly siteId: string
  readonly styleId: string
  /** P1, the seeds' customer: what must never reach brand B. */
  readonly a: BrandInProduction
  /** The threads' second brand: the reader. */
  readonly b: BrandInProduction
  readonly second: SecondBrand
  /** A work order of no customer made before the rule: a cell of each brand ("Mixed brands (made before the rule)"). */
  readonly mixed: { readonly workOrderId: string; readonly number: string }
}

const grantOf = (permissions: readonly Permission[], parties: Grant['parties']): Grant => ({ permissions: [...permissions], companies: 'all', sites: 'all', parties })

/** The office sessions of the wall: every customer, and one limited to each brand (the same permissions). */
export function twoBrandSessions(tenantId: string, a: string, b: string, permissions: readonly Permission[]): Record<'office.all' | 'office.p1' | 'office.p2', SessionContext> {
  const office = (parties: Grant['parties']): SessionContext => ({ audience: 'office', tenantId, actorId: newId(), grants: [grantOf(permissions, parties)] })
  return { 'office.all': office('all'), 'office.p1': office([a]), 'office.p2': office([b]) }
}

/** The ids the harness uses before it runs (its sessions name the two parties). */
export function twoBrandIds(namespace: string): { readonly tenantId: string; readonly a: string; readonly b: string } {
  const second = `ffffffff${seedUuid(namespace, 'second-brand:party').slice(8)}`
  return { tenantId: seedUuid(namespace, 'tenant'), a: seedUuid(namespace, 'party:P1'), b: second }
}

const sql = (value: string): string => {
  if (!isUuid(value)) throw new Error(`not an id: ${value}`)
  return `'${value}'`
}

export async function productionTwoBrands(t: { readonly db: MigratedDatabase; readonly database: FactoryDatabase; readonly app: FastifyInstance; readonly namespace: string }): Promise<ProductionTwoBrands> {
  const id = (key: string) => seedUuid(t.namespace, key)
  const tenantId = id('tenant')
  const actorId = id('actor')
  const companyId = id('company:A')
  const siteId = id('site:A1')
  const second = await seedSecondBrand({ db: t.database, namespace: t.namespace })
  const a = id('party:P1')
  const b = second.partyId
  const styleId = newId()
  const blk = newId()
  const revisionId = newId()
  const seeded = { style: id('production:style:JKT-02'), blk: id('production:colourway:JKT-02:BLK'), revision: `ffffffff${id('production:revision:JKT-02:1').slice(8)}` }

  // Our own collection's jacket: the seed's released SEED-JKT-02 copied with no brand and no label template.
  await t.db.admin.query(
    `BEGIN;
     SET LOCAL session_replication_role = replica;
     INSERT INTO "Style" SELECT (jsonb_populate_record(NULL::"Style", to_jsonb(s) || jsonb_build_object('id', ${sql(styleId)}, 'code', '${OWN_STYLE_CODE}', 'name', 'Our own production jacket', 'brandPartyId', NULL, 'soldUnderOurName', false))).* FROM "Style" s WHERE s.id = ${sql(seeded.style)};
     INSERT INTO "Colourway" SELECT (jsonb_populate_record(NULL::"Colourway", to_jsonb(c) || jsonb_build_object('id', ${sql(blk)}, 'styleId', ${sql(styleId)}))).* FROM "Colourway" c WHERE c.id = ${sql(seeded.blk)};
     INSERT INTO "StyleRevision" SELECT (jsonb_populate_record(NULL::"StyleRevision", to_jsonb(r) || jsonb_build_object('id', ${sql(revisionId)}, 'styleId', ${sql(styleId)}, 'labelTemplateId', NULL))).* FROM "StyleRevision" r WHERE r.id = ${sql(seeded.revision)};
     COMMIT;`,
  )

  // One order line per brand: A's on a new order of its own, B's on the threads' SEED-SO-B001. Two of each size 50 and 52 go on
  // the work order; what stays open feeds the mixed one.
  const alphaOrder = newId()
  const lines = { a: newId(), b: newId() }
  await t.database.withScope({ audience: 'office', tenantId, actorId }, (client) =>
    client.$transaction(async (tx) => {
      await tx.salesOrder.create({
        data: { id: alphaOrder, companyId, partyId: a, number: `T-PR03-SO-${alphaOrder.slice(-6)}`, customerRef: `T-PR03-PO-${alphaOrder.slice(-6)}`, status: 'CONFIRMED', orderDate: new Date('2026-11-02T00:00:00.000Z'), taxMode: 'IT_B2B', billTo: { legalName: 'Made-up customer' }, shipTo: { name: 'Made-up workshop' }, promiseDate: new Date('2026-12-18T00:00:00.000Z') },
        select: { id: true },
      })
      for (const [key, orderId, partyId] of [['a', alphaOrder, a], ['b', second.salesOrderId, b]] as const) {
        await tx.salesOrderLine.create({
          data: { id: lines[key], companyId, orderId, partyId, seq: 900, kind: 'SIZE_GRID', styleId, colourwayId: blk, quantity: 10, unitPrice: '100.000000', netAmount: 100_000, vatRatePct: '22.00', vatAmount: 22_000 },
          select: { id: true },
        })
        await tx.salesOrderLineSize.createMany({ data: [['50', 4], ['52', 4], ['54', 2]].map(([size, quantity]) => ({ id: newId(), lineId: lines[key], partyId, size: size as string, quantity: quantity as number })) })
      }
    }),
  )

  const make = async (salesOrderLineId: string) => {
    const response = await t.app.inject({ method: 'POST', url: '/production/work-orders', headers: { 'x-test-session': 'office.all' }, payload: { siteId, lines: [{ salesOrderLineId, sizes: [{ size: '50', quantity: 2 }, { size: '52', quantity: 2 }] }] } })
    if (response.statusCode !== 201) throw new Error(`the harness's work order: ${response.statusCode} ${response.body}`)
    const { workOrder } = response.json() as { workOrder: { id: string; number: string } }
    return { workOrderId: workOrder.id, workOrderNumber: workOrder.number }
  }
  const alpha: BrandInProduction = { partyId: a, salesOrderId: alphaOrder, salesOrderLineId: lines.a, ...(await make(lines.a)) }
  const beta: BrandInProduction = { partyId: b, salesOrderId: second.salesOrderId, salesOrderLineId: lines.b, ...(await make(lines.b)) }

  // A work order made before the one-customer rule: A's work order copied with no customer, and one open cell of each brand
  // (A's size 54, B's size 52; the database's rules off for this one statement, as the copy step met such work orders).
  const mixed = { workOrderId: newId(), number: `T-PR03-MIX-${alpha.workOrderId.slice(-6)}` }
  const cellOf = (workOrderId: string, cellId: string, size: string) =>
    `INSERT INTO "WorkOrderSize" SELECT (jsonb_populate_record(NULL::"WorkOrderSize", to_jsonb(c) || jsonb_build_object('id', ${sql(cellId)}, 'workOrderId', ${sql(mixed.workOrderId)}, 'size', '${size}', 'quantity', 1))).* FROM "WorkOrderSize" c WHERE c."workOrderId" = ${sql(workOrderId)} AND c.size = '50';`
  await t.db.admin.query(
    `BEGIN;
     SET LOCAL session_replication_role = replica;
     INSERT INTO "WorkOrder" SELECT (jsonb_populate_record(NULL::"WorkOrder", to_jsonb(w) || jsonb_build_object('id', ${sql(mixed.workOrderId)}, 'number', '${mixed.number}', 'partyId', NULL))).* FROM "WorkOrder" w WHERE w.id = ${sql(alpha.workOrderId)};
     ${cellOf(alpha.workOrderId, newId(), '54')}
     ${cellOf(beta.workOrderId, newId(), '52')}
     COMMIT;`,
  )
  return { tenantId, companyId, siteId, styleId, a: alpha, b: beta, second, mixed }
}

/**
 * Everything of a customer that must never reach another: the threads' record markers (its names, code, contacts, addresses,
 * orders, references, files, threads, ids) and its work orders' numbers, batch numbers and ids, without repeats. Short values
 * (under 6 characters) are left out, as theirs.
 */
export async function markersOf(db: MigratedDatabase, partyId: string): Promise<Marker[]> {
  // recordMarkers reads through a golden-flow world's admin pool only; a module's PG test has the same pool on its database.
  const records = await recordMarkers({ h: { db } } as unknown as World, partyId)
  const production = (
    await db.admin.query(
      `SELECT 'work order' AS label, number AS text FROM "WorkOrder" WHERE "partyId" = $1
       UNION ALL SELECT 'work order', id::text FROM "WorkOrder" WHERE "partyId" = $1
       UNION ALL SELECT 'batch', "batchNumber" FROM "WorkOrder" WHERE "partyId" = $1`,
      [partyId],
    )
  ).rows as { label: string; text: string | null }[]
  const seen = new Set<string>()
  return [...records, ...production.filter((row): row is Marker => typeof row.text === 'string' && row.text.trim().length >= 6).map((row) => ({ label: row.label, text: row.text.trim() }))].filter((marker) => {
    const key = marker.text.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export { findMarkers, type Marker }
