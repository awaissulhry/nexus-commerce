import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { seed as seedCore, type CoreSeed } from '../seed/_core'
import { seed as seedCompliance, type ComplianceSeed } from '../seed/compliance'
import { seed as seedProduct, type ProductSeed } from '../seed/product'
import { openFactoryDatabase, type FactoryClient, type FactoryDatabase, type FactoryScope } from './client'
import { classifiedModels } from './ownership'
import { FLOOR_ROLE, RUNTIME_LOGIN } from './roles'
import { migratedDatabase, type MigratedDatabase } from './testing/database'
import { loadOwnership, loadSchema } from './tools'

/**
 * The product and compliance walls beyond the generated isolation tests (plan A1 §2.2, §2.5, §2.6; features PRD-022,
 * PRD-110, QHS-103), on a database built from the migrations and seeded twice (tenants A and B), through the real login
 * and the scoped client:
 *   - the floor (factory_floor_runtime) reads styles, SKUs, BOMs and routings, and never a cost, price or margin column
 *     of any table of product.prisma or compliance.prisma;
 *   - a RELEASED style revision never changes, nor do its BOM lines, size quantities, colour cells and routing operations,
 *     for any login, the owner included (the …_product_guards triggers); a release waits for an edit of its parts;
 *   - a certificate's validity dates are required, end after they start and span at most five years; a registered
 *     certificate, an active label template and an issued compliance document change only their status;
 *   - a material's Cr VI limit, a coverage's subject and every reference stay as the schema says;
 *   - the seeds are idempotent.
 * A refusal raised as restrict_violation (SQLSTATE 23001) reaches a Prisma model call as P2003 without its message, so
 * the messages are checked through the scoped client's raw SQL, as the files test does.
 */

const DENIED = /permission denied/
const PRODUCT_FILES = new Set(['product.prisma', 'compliance.prisma'])
const FLOOR_HIDDEN_GRAINS = new Set(['@grain cost', '@grain price', '@grain margin'])
const PARTS = ['BomLine', 'BomLineSize', 'BomLineColour', 'RoutingOperation'] as const

let db: MigratedDatabase
let factory: FactoryDatabase
let a: CoreSeed
let b: CoreSeed
let productA: ProductSeed
let productB: ProductSeed
let complianceA: ComplianceSeed

const office = (seeded: CoreSeed): FactoryScope => ({ audience: 'office', tenantId: seeded.tenantId, actorId: seeded.actorId })
const floor = (): FactoryScope => ({ audience: 'floor', tenantId: a.tenantId, actorId: a.actorId, siteId: a.sites[0]!.id })
const as = <T>(scope: FactoryScope, work: (client: FactoryClient) => Promise<T>): Promise<T> => factory.withScope(scope, work)
const sql = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$queryRawUnsafe<Record<string, unknown>[]>(text, ...values))
const run = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$executeRawUnsafe(text, ...values))
const admin = async (text: string, values: unknown[] = []) => (await db.admin.query(text, values)).rows as Record<string, unknown>[]
const one = async (text: string, values: unknown[] = []) => (await admin(text, values))[0] as Record<string, unknown>

beforeAll(async () => {
  db = await migratedDatabase('product')
  factory = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 4 } })
  a = await seedCore({ db: factory, namespace: 'product-a' })
  b = await seedCore({ db: factory, namespace: 'product-b' })
  productA = await seedProduct({ db: factory, namespace: 'product-a' })
  productB = await seedProduct({ db: factory, namespace: 'product-b' })
  complianceA = await seedCompliance({ db: factory, namespace: 'product-a' })
  await seedCompliance({ db: factory, namespace: 'product-b' })
}, 60_000)

afterAll(async () => {
  await factory?.close()
  await db?.close()
}, 60_000)

/** A new DRAFT revision of tenant A's style with one part of each kind; returns the ids. */
async function draftRevision(revision: number): Promise<{ revisionId: string; lineId: string; sizeId: string; cellId: string; stepId: string }> {
  const ids = { revisionId: randomUUID(), lineId: randomUUID(), sizeId: randomUUID(), cellId: randomUUID(), stepId: randomUUID() }
  const { styleId, leatherId, colourwayIds } = productA
  const colour = await one('SELECT id::text AS id FROM "ItemColour" WHERE "tenantId" = $1 AND "itemId" = $2 AND code = $3', [a.tenantId, leatherId, 'BLK'])
  const operation = await one('SELECT id::text AS id FROM "Operation" WHERE "tenantId" = $1 AND code = $2', [a.tenantId, 'SEED-SEW-ASM'])
  await as(office(a), (client) =>
    client.$transaction(async (tx) => {
      await tx.styleRevision.create({ data: { id: ids.revisionId, styleId, revision }, select: { id: true } })
      await tx.bomLine.create({
        data: { id: ids.lineId, styleId, revisionId: ids.revisionId, seq: 10, itemId: leatherId, qty: '45.0000', uom: 'FT2', sizeDependent: true, colourDependent: true },
        select: { id: true },
      })
      await tx.bomLineSize.create({ data: { id: ids.sizeId, revisionId: ids.revisionId, bomLineId: ids.lineId, size: '52', qty: '45.0000' }, select: { id: true } })
      await tx.bomLineColour.create({
        data: { id: ids.cellId, styleId, revisionId: ids.revisionId, bomLineId: ids.lineId, itemId: leatherId, colourwayId: colourwayIds[0]!, itemColourId: String(colour.id) },
        select: { id: true },
      })
      await tx.routingOperation.create({
        data: { id: ids.stepId, styleId, revisionId: ids.revisionId, seq: 10, operationId: String(operation.id), code: 'SEED-SEW-ASM', name: 'Sew', workCentreKind: 'SEWING', standardMinutes: '96.500' },
        select: { id: true },
      })
    }),
  )
  return ids
}

const release = (revisionId: string) =>
  as(office(a), (client) =>
    client.styleRevision.update({ where: { id: revisionId }, data: { status: 'RELEASED', releasedAt: new Date(), releasedById: a.actorId }, select: { status: true } }),
  )

describe('the floor', () => {
  const models = classifiedModels(loadSchema(), loadOwnership()).filter(({ model }) => PRODUCT_FILES.has(model.file))

  it('never reads a cost, price or margin column of a product or compliance table', async () => {
    const walled = models.flatMap(({ model, ownership }) =>
      model.fields.filter((field) => !field.relation && field.tags.some((tag) => FLOOR_HIDDEN_GRAINS.has(tag))).map((field) => ({ model, ownership, column: field.column })),
    )
    // Not vacuous: the standard cost is such a column.
    expect(walled.map(({ model, column }) => `${model.name}.${column}`)).toContain('Item.standardCost')
    for (const { model, ownership, column } of walled) {
      const access = ownership.access[FLOOR_ROLE]
      if (access) expect(access.hiddenColumns ?? [], `${model.name}.${column}`).toContain(column)
      await expect(sql(floor(), `SELECT "${column}" FROM "${model.table}" LIMIT 1`), `${model.name}.${column}`).rejects.toThrow(DENIED)
      expect((await sql(office(a), `SELECT "${column}" FROM "${model.table}"`)).length, `${model.name}.${column} for the office`).toBeGreaterThan(0)
    }
    // Prisma's default select names every column, so a forgotten select fails loudly.
    await expect(as(floor(), (client) => client.item.findMany())).rejects.toThrow(DENIED)
  })

  it('reads the styles, SKUs, BOM and routing it works from, and writes none of them', async () => {
    const seen = await as(floor(), (client) =>
      client.style.findMany({
        select: {
          code: true,
          sizes: true,
          colourways: { select: { code: true, variants: { select: { sku: true }, orderBy: { sku: 'asc' } } }, orderBy: { code: 'asc' } },
          revisions: {
            where: { revision: 1 },
            select: {
              revision: true,
              bomLines: { select: { seq: true, qty: true, uom: true, item: { select: { code: true, baseUom: true } } }, orderBy: { seq: 'asc' } },
              routing: { select: { seq: true, code: true, standardMinutes: true }, orderBy: { seq: 'asc' } },
            },
          },
        },
      }),
    )
    expect(seen).toHaveLength(1)
    const [style] = seen
    expect(style!.code).toBe('SEED-JKT-01')
    expect(style!.sizes).toEqual(['50', '52', '54'])
    expect(style!.colourways.map((colourway) => [colourway.code, colourway.variants.length])).toEqual([
      ['BLK', 3],
      ['RED', 3],
    ])
    const [revision] = style!.revisions
    expect(revision!.bomLines.map((line) => [line.item.code, line.uom, line.qty.toString()])).toEqual([
      ['SEED-LEA-100', 'FT2', '45'],
      ['SEED-LIN-200', 'M', '1.8'],
      ['SEED-PRO-300', 'PCS', '2'],
    ])
    expect(revision!.routing.map((step) => [step.code, step.standardMinutes.toString()])).toEqual([
      ['SEED-CUT-LEA', '14'],
      ['SEED-SEW-ASM', '96.5'],
      ['SEED-FIN-QC', '8'],
      ['SEED-PACK', '3.5'],
    ])
    for (const { model } of models) {
      await expect(run(floor(), `INSERT INTO "${model.table}" (id) VALUES (NULL)`), model.name).rejects.toThrow(DENIED)
      await expect(run(floor(), `UPDATE "${model.table}" SET id = id WHERE false`), model.name).rejects.toThrow(DENIED)
    }
  })
})

describe('a released style revision', () => {
  let parts: Awaited<ReturnType<typeof draftRevision>>
  beforeAll(async () => {
    parts = await draftRevision(2)
    expect(await release(parts.revisionId)).toEqual({ status: 'RELEASED' })
  })

  it('never changes but to OBSOLETE, for the office', async () => {
    const change = (set: string, ...values: unknown[]) => run(office(a), `UPDATE "StyleRevision" SET ${set} WHERE id = $1::uuid`, parts.revisionId, ...values)
    await expect(change('"changeNote" = $2', 'Edited after release')).rejects.toThrow(/revision .* is RELEASED; it never changes/)
    await expect(change('"plannedHideYieldPct" = 80')).rejects.toThrow(/never changes/)
    await expect(change('"labelTemplateId" = $2::uuid', complianceA.labelTemplateId)).rejects.toThrow(/never changes/)
    await expect(change(`status = 'DRAFT', "releasedAt" = NULL, "releasedById" = NULL`)).rejects.toThrow(/cannot move from RELEASED to DRAFT/)
    await expect(change('revision = 7')).rejects.toThrow(/the style, number and creation of revision .* never change/)
    // Through a Prisma model call the same refusal arrives without its message (P2003).
    await expect(as(office(a), (client) => client.styleRevision.update({ where: { id: parts.revisionId }, data: { changeNote: 'x' }, select: { id: true } }))).rejects.toThrow()
    await expect(run(office(a), 'DELETE FROM "StyleRevision" WHERE id = $1::uuid', parts.revisionId)).rejects.toThrow(DENIED)
  })

  it('takes no new part and keeps every part as it is, for the office', async () => {
    const { styleId, leatherId } = productA
    const asOffice = (text: string, ...values: unknown[]) => run(office(a), text, ...values)
    await expect(
      asOffice(
        `INSERT INTO "BomLine" (id, "styleId", "revisionId", seq, "itemId", qty, uom) VALUES ($1::uuid, $2::uuid, $3::uuid, 20, $4::uuid, 1, 'FT2')`,
        randomUUID(),
        styleId,
        parts.revisionId,
        leatherId,
      ),
    ).rejects.toThrow(/revision .* is RELEASED; its "BomLine" rows never change/)
    await expect(
      asOffice(`INSERT INTO "BomLineSize" (id, "revisionId", "bomLineId", size, qty) VALUES ($1::uuid, $2::uuid, $3::uuid, '54', 47)`, randomUUID(), parts.revisionId, parts.lineId),
    ).rejects.toThrow(/its "BomLineSize" rows never change/)
    await expect(asOffice('UPDATE "BomLine" SET qty = 50 WHERE id = $1::uuid', parts.lineId)).rejects.toThrow(/its "BomLine" rows never change/)
    await expect(asOffice('UPDATE "BomLineSize" SET qty = 1 WHERE id = $1::uuid', parts.sizeId)).rejects.toThrow(/its "BomLineSize" rows never change/)
    await expect(asOffice('UPDATE "BomLineColour" SET "updatedAt" = now() WHERE id = $1::uuid', parts.cellId)).rejects.toThrow(/its "BomLineColour" rows never change/)
    await expect(asOffice('UPDATE "RoutingOperation" SET "standardMinutes" = 1 WHERE id = $1::uuid', parts.stepId)).rejects.toThrow(
      /its "RoutingOperation" rows never change/,
    )
    await expect(as(office(a), (client) => client.bomLine.update({ where: { id: parts.lineId }, data: { qty: '50' }, select: { id: true } }))).rejects.toThrow()
    // An UPDATE that changes nothing passes (the generated isolation tests rely on it).
    expect(await run(office(a), 'UPDATE "RoutingOperation" SET "standardMinutes" = "standardMinutes" WHERE id = $1::uuid', parts.stepId)).toBe(1)
  })

  it('is frozen for every login, the owner included', async () => {
    await expect(admin('UPDATE "StyleRevision" SET "changeNote" = $2 WHERE id = $1', [parts.revisionId, 'x'])).rejects.toThrow(/never changes/)
    await expect(admin('DELETE FROM "StyleRevision" WHERE id = $1', [parts.revisionId])).rejects.toThrow(/is RELEASED; it is kept, never deleted/)
    await expect(admin('TRUNCATE "StyleRevision" CASCADE')).rejects.toThrow(/TRUNCATE on "StyleRevision" is refused/)
    for (const [table, id] of [
      ['BomLine', parts.lineId],
      ['BomLineSize', parts.sizeId],
      ['BomLineColour', parts.cellId],
      ['RoutingOperation', parts.stepId],
    ] as const) {
      await expect(admin(`UPDATE "${table}" SET "updatedAt" = now() WHERE id = $1`, [id]), table).rejects.toThrow(/never change/)
      await expect(admin(`DELETE FROM "${table}" WHERE id = $1`, [id]), table).rejects.toThrow(/never change/)
      await expect(admin(`TRUNCATE "${table}" CASCADE`), table).rejects.toThrow(new RegExp(`TRUNCATE on "${table}" is refused`))
    }
    for (const table of PARTS) {
      const [{ n }] = (await admin(`SELECT count(*)::int AS n FROM "${table}" WHERE "revisionId" = $1`, [parts.revisionId])) as [{ n: number }]
      expect(n, table).toBe(1)
    }
  })

  it('moves to OBSOLETE, and then changes no more', async () => {
    const obsolete = await draftRevision(3)
    await release(obsolete.revisionId)
    const status = (to: 'OBSOLETE' | 'RELEASED') => run(office(a), `UPDATE "StyleRevision" SET status = '${to}' WHERE id = $1::uuid`, obsolete.revisionId)
    expect(await status('OBSOLETE')).toBe(1)
    await expect(status('RELEASED')).rejects.toThrow(/cannot move from OBSOLETE to RELEASED/)
    await expect(run(office(a), `UPDATE "BomLine" SET note = 'x' WHERE id = $1::uuid`, obsolete.lineId)).rejects.toThrow(/is OBSOLETE; its "BomLine" rows never change/)
  })

  it('needs its release time; a draft has none', async () => {
    const draft = await draftRevision(4)
    await expect(
      as(office(a), (client) => client.styleRevision.update({ where: { id: draft.revisionId }, data: { status: 'RELEASED' }, select: { id: true } })),
    ).rejects.toThrow(/is RELEASED with the wrong release time/)
    await expect(
      as(office(a), (client) => client.styleRevision.update({ where: { id: draft.revisionId }, data: { releasedAt: new Date() }, select: { id: true } })),
    ).rejects.toThrow(/is DRAFT with the wrong release time/)
  })
})

describe('a draft style revision', () => {
  it('is edited freely, and a release waits for a running edit of its parts', async () => {
    const draft = await draftRevision(5)
    const edited = await as(office(a), (client) => client.bomLine.update({ where: { id: draft.lineId }, data: { qty: '46.0000', note: 'Longer body' }, select: { qty: true } }))
    expect(edited.qty.toString()).toBe('46')
    expect(await run(office(a), 'UPDATE "BomLineSize" SET qty = 46 WHERE id = $1::uuid', draft.sizeId)).toBe(1)

    // An edit holds the revision row FOR SHARE until it commits: the release cannot slip in between.
    const editor = new pg.Client({ connectionString: db.url('postgres') })
    const releaser = new pg.Client({ connectionString: db.url('postgres') })
    await editor.connect()
    await releaser.connect()
    try {
      await editor.query('BEGIN')
      await editor.query('UPDATE "BomLineSize" SET qty = 47 WHERE id = $1', [draft.sizeId])
      await releaser.query("SET lock_timeout = '300ms'")
      await expect(releaser.query(`UPDATE "StyleRevision" SET status = 'RELEASED', "releasedAt" = now() WHERE id = $1`, [draft.revisionId])).rejects.toThrow(
        /lock timeout/,
      )
      await editor.query('COMMIT')
      await releaser.query(`UPDATE "StyleRevision" SET status = 'RELEASED', "releasedAt" = now() WHERE id = $1`, [draft.revisionId])
      await expect(editor.query('UPDATE "BomLineSize" SET qty = 48 WHERE id = $1', [draft.sizeId])).rejects.toThrow(/is RELEASED/)
    } finally {
      await editor.query('ROLLBACK').catch(() => {})
      await editor.end()
      await releaser.end()
    }
    expect(await one('SELECT qty::text AS qty FROM "BomLineSize" WHERE id = $1', [draft.sizeId])).toEqual({ qty: '47.0000' })
  })

  it("never names another tenant's material, another material's colour or another style's colourway", async () => {
    const draft = await draftRevision(6)
    const { styleId, leatherId } = productA
    const line = (data: Record<string, unknown>) =>
      as(office(a), (client) =>
        client.bomLine.create({ data: { id: randomUUID(), styleId, revisionId: draft.revisionId, seq: 90, itemId: leatherId, qty: '1', uom: 'FT2', ...data } as never, select: { id: true } }),
      )
    await expect(line({ itemId: productB.leatherId })).rejects.toThrow(/BomLine_tenantId_itemId_fkey/)
    const lining = await one('SELECT id::text AS id FROM "ItemColour" WHERE "tenantId" = $1 AND code = $2', [a.tenantId, 'GRY'])
    await expect(line({ itemColourId: String(lining.id) })).rejects.toThrow(/BomLine_tenantId_itemId_itemColourId_fkey/)
    await expect(line({ colourwayId: productB.colourwayIds[0] })).rejects.toThrow(/BomLine_tenantId_styleId_colourwayId_fkey/)
    await expect(
      as(office(a), (client) =>
        client.bomLineColour.create({
          data: { id: randomUUID(), styleId, revisionId: draft.revisionId, bomLineId: draft.lineId, itemId: leatherId, colourwayId: productA.colourwayIds[1]!, itemColourId: String(lining.id) },
          select: { id: true },
        }),
      ),
    ).rejects.toThrow(/BomLineColour_tenantId_itemId_itemColourId_fkey/)
  })
})

describe('a certificate', () => {
  const insert = (columns: Record<string, unknown>) => {
    const row = {
      id: randomUUID(),
      holderPartyId: null,
      companyId: a.companies[0]!.id,
      standard: 'EN 17092-4:2020',
      number: `TEST-${randomUUID().slice(0, 8)}`,
      notifiedBodyName: 'Seed Notified Body',
      notifiedBodyNumber: '0000',
      validFrom: '2026-01-01',
      validTo: '2030-12-31',
      ...columns,
    }
    // Only the named columns: the others keep their defaults (tenantId, status DRAFT, version).
    const names = Object.keys(row)
      .map((name) => `"${name}"`)
      .join(', ')
    return run(office(a), `INSERT INTO "Certificate" (${names}) SELECT ${names} FROM jsonb_populate_record(NULL::"Certificate", $1::jsonb)`, JSON.stringify(row))
  }

  it('has its validity dates: both required, the end after the start, at most five years apart', async () => {
    await expect(insert({ validTo: null })).rejects.toThrow(/null value in column "validTo"/)
    await expect(insert({ validFrom: null })).rejects.toThrow(/null value in column "validFrom"/)
    await expect(insert({ validTo: '2025-12-31' })).rejects.toThrow(/ends .* before it starts/)
    await expect(insert({ validTo: '2026-01-01' })).rejects.toThrow(/ends .* before it starts/)
    await expect(insert({ validTo: '2031-01-02' })).rejects.toThrow(/valid for more than five years/)
    await expect(insert({ companyId: null })).rejects.toThrow(/held by a company or a brand party/)
    expect(await insert({ validTo: '2031-01-01' })).toBe(1)
  })

  it('once registered, changes only its status, along the allowed moves', async () => {
    const certificateId = randomUUID()
    await insert({ id: certificateId, number: 'TEST-REGISTERED' })
    const update = (set: string) => run(office(a), `UPDATE "Certificate" SET ${set} WHERE id = $1::uuid`, certificateId)
    // A draft is edited freely.
    expect(
      await as(office(a), (client) => client.certificate.update({ where: { id: certificateId }, data: { ppeClass: 'AA', modelReference: 'TEST-MODEL' }, select: { status: true } })),
    ).toEqual({ status: 'DRAFT' })
    expect(await update(`status = 'VALID', "statusChangedAt" = now()`)).toBe(1)
    await expect(update(`number = 'TEST-OTHER'`)).rejects.toThrow(/is VALID; only its status changes/)
    await expect(update(`"validTo" = '2030-06-30'`)).rejects.toThrow(/only its status changes/)
    expect(await update(`status = 'SUSPENDED', "statusReason" = 'Seed audit finding', "statusChangedAt" = now()`)).toBe(1)
    await expect(update(`status = 'DRAFT'`)).rejects.toThrow(/cannot move from SUSPENDED to DRAFT/)
    expect(await update(`status = 'WITHDRAWN'`)).toBe(1)
    await expect(update(`status = 'VALID'`)).rejects.toThrow(/cannot move from WITHDRAWN to VALID/)
    await expect(admin('UPDATE "Certificate" SET number = $2 WHERE id = $1', [certificateId, 'X'])).rejects.toThrow(/only its status changes/)
    await expect(admin('DELETE FROM "Certificate" WHERE id = $1', [certificateId])).rejects.toThrow(/is WITHDRAWN; it is kept, never deleted/)
    await expect(admin('TRUNCATE "Certificate" CASCADE')).rejects.toThrow(/TRUNCATE on "Certificate" is refused/)
  })

  it('covers exactly one style or one item, and a coverage is never removed', async () => {
    const coverage = (data: Record<string, unknown>) =>
      as(office(a), (client) => client.certificateCoverage.create({ data: { id: randomUUID(), certificateId: complianceA.certificateId, ...data }, select: { id: true } }))
    await expect(coverage({})).rejects.toThrow(/covers exactly one style .* or one item/)
    await expect(coverage({ styleId: productA.styleId, itemId: productA.protectorId })).rejects.toThrow(/covers exactly one style/)
    await expect(coverage({ itemId: productA.protectorId, sizes: ['52'] })).rejects.toThrow(/covers exactly one style/)
    await expect(coverage({ styleId: productB.styleId })).rejects.toThrow(/CertificateCoverage_tenantId_styleId_fkey/)
    const { id } = await coverage({ styleId: productA.styleId, sizes: ['50', '52'] })
    await expect(
      run(office(a), `UPDATE "CertificateCoverage" SET "itemId" = $2::uuid, "styleId" = NULL, sizes = '{}' WHERE id = $1::uuid`, id, productA.protectorId),
    ).rejects.toThrow(/the certificate and the style or item of coverage .* never change/)
    expect(await run(office(a), `UPDATE "CertificateCoverage" SET status = 'ARCHIVED' WHERE id = $1::uuid`, id)).toBe(1)
    await expect(admin('DELETE FROM "CertificateCoverage" WHERE id = $1', [id])).rejects.toThrow(/DELETE on "CertificateCoverage" is refused/)
  })
})

describe('a label template and a compliance document', () => {
  it('an active label template changes only its status', async () => {
    const update = (set: string) => run(office(a), `UPDATE "LabelTemplate" SET ${set} WHERE id = $1::uuid`, complianceA.labelTemplateId)
    await expect(update(`"makerAddress" = 'Somewhere else'`)).rejects.toThrow(/label template .* is ACTIVE; only its status changes/)
    await expect(update(`layout = '{}'`)).rejects.toThrow(/only its status changes/)
    await expect(update(`status = 'DRAFT'`)).rejects.toThrow(/cannot move from ACTIVE to DRAFT/)
    await expect(update(`revision = 2`)).rejects.toThrow(/the code, revision and creation of label template .* never change/)
    await expect(admin('DELETE FROM "LabelTemplate" WHERE id = $1', [complianceA.labelTemplateId])).rejects.toThrow(/is ACTIVE; it is kept/)
  })

  it('an issued Declaration of Conformity changes only its status', async () => {
    const [doc] = await admin('SELECT id::text AS id FROM "ComplianceDocument" WHERE "tenantId" = $1', [a.tenantId])
    const update = (data: Record<string, unknown>) =>
      as(office(a), (client) => client.complianceDocument.update({ where: { id: String(doc!.id) }, data, select: { status: true } }))
    await expect(update({ status: 'ISSUED' })).rejects.toThrow(/is ISSUED with the wrong issue time/)
    expect(
      await update({ signedByName: 'Seed Signer', signedByFunction: 'Seed director', signedPlace: 'Seedville', signedOn: new Date('2026-10-28T00:00:00.000Z') }),
    ).toEqual({ status: 'DRAFT' })
    expect(await update({ status: 'ISSUED', issuedAt: new Date() })).toEqual({ status: 'ISSUED' })
    const raw = (set: string) => run(office(a), `UPDATE "ComplianceDocument" SET ${set} WHERE id = $1::uuid`, String(doc!.id))
    await expect(raw(`standards = '{EN 17092-1:2020}'`)).rejects.toThrow(/document .* is ISSUED; only its status changes/)
    await expect(raw(`language = 'it'`)).rejects.toThrow(/never change/)
    await expect(admin('DELETE FROM "ComplianceDocument" WHERE id = $1', [doc!.id])).rejects.toThrow(/is ISSUED; it is kept/)
    expect(await update({ status: 'SUPERSEDED' })).toEqual({ status: 'SUPERSEDED' })
    await expect(raw(`status = 'ISSUED'`)).rejects.toThrow(/cannot move from SUPERSEDED to ISSUED/)
  })
})

describe('a material', () => {
  it('has a Cr VI limit exactly when its lots need a test, and never above 3 mg/kg', async () => {
    const update = (data: Record<string, unknown>) =>
      as(office(a), (client) => client.item.update({ where: { id: productA.leatherId }, data, select: { id: true } }))
    await expect(update({ crViLimitMgKg: null })).rejects.toThrow(/has a Cr VI limit exactly when its lots need a Cr VI test/)
    await expect(update({ requiresCrViTest: false })).rejects.toThrow(/exactly when/)
    await expect(update({ crViLimitMgKg: '3.5' })).rejects.toThrow(/at most 3 mg\/kg/)
    await expect(update({ purchaseFactor: '0' })).rejects.toThrow(/unit factors .* are above 0/)
    expect(await update({ crViLimitMgKg: '2.000' })).toEqual({ id: productA.leatherId })
    expect(await update({ crViLimitMgKg: '3.000' })).toEqual({ id: productA.leatherId })
  })
})

describe('the seeds', () => {
  it('are idempotent: a second run changes nothing', async () => {
    const tables = models().map(({ model }) => model.table)
    const count = async () => {
      const out: Record<string, number> = {}
      for (const table of tables) out[table] = Number((await one(`SELECT count(*)::int AS n FROM "${table}" WHERE "tenantId" = $1`, [b.tenantId])).n)
      return out
    }
    const before = await count()
    expect(Object.values(before).every((n) => n > 0)).toBe(true)
    const stamps = await admin('SELECT id, "updatedAt" FROM "BomLine" WHERE "tenantId" = $1 ORDER BY id', [b.tenantId])
    await seedCompliance({ db: factory, namespace: 'product-b' })
    expect(await count()).toEqual(before)
    expect(await admin('SELECT id, "updatedAt" FROM "BomLine" WHERE "tenantId" = $1 ORDER BY id', [b.tenantId])).toEqual(stamps)
  })

  it('leave a released revision as it is', async () => {
    await as(office(b), (client) =>
      client.styleRevision.update({ where: { id: productB.revisionId }, data: { status: 'RELEASED', releasedAt: new Date(), releasedById: b.actorId }, select: { id: true } }),
    )
    await seedCompliance({ db: factory, namespace: 'product-b' })
    expect(await one('SELECT status::text AS status FROM "StyleRevision" WHERE id = $1', [productB.revisionId])).toEqual({ status: 'RELEASED' })
  })
})

function models() {
  return classifiedModels(loadSchema(), loadOwnership()).filter(({ model }) => PRODUCT_FILES.has(model.file))
}
