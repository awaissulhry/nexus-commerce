import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { seed as seedCore, type CoreSeed } from '../seed/_core'
import { seed as seedProduct, type ProductSeed } from '../seed/product'
import { seed as seedSales, type SalesSeed } from '../seed/sales'
import { openFactoryDatabase, type FactoryClient, type FactoryDatabase, type FactoryScope } from './client'
import { classifiedModels, partnerWalledColumns } from './ownership'
import { FLOOR_ROLE, PARTNER_ROLE, RUNTIME_LOGIN } from './roles'
import { seedUuid } from './seeding'
import { migratedDatabase, type MigratedDatabase } from './testing/database'
import { loadOwnership, loadSchema } from './tools'

/**
 * The sales walls beyond the generated isolation tests (plan A1 §2.2, §2.5, §2.6; PLAN §2.8 "Codice del Consumo";
 * features SAL-157, SAL-184, SAL-195, SAL-204, SAL-304), on a database built from the migrations and seeded twice
 * (tenants A and B), through the real login and the scoped client:
 *   - a portal or link session (factory_partner_runtime) reads only its own party's quotes, versions, lines,
 *     acceptances, deposit requests and orders, with their prices, never a cost, margin or internal column; the floor
 *     reads nothing of sales;
 *   - a quote version's lines change only while it is DRAFT; a SENT version changes only its decision, a decided one
 *     never, for any login, the owner included (the …_sales_guards triggers); a version starts as DRAFT;
 *   - the accept link (the partner role) only moves its party's SENT version and quote to ACCEPTED or DECLINED;
 *   - an acceptance is append-only, names the ACCEPTED version's document and, for a version that states no right of
 *     withdrawal, the consumer's acceptance of that statement;
 *   - a quote has at most one ACCEPTED version (the partial unique index);
 *   - an order is made from an ACCEPTED version of its own company's quote; its lines change only while it is
 *     CONFIRMED, IN_PRODUCTION or READY; CLOSED comes only from SHIPPED, CANCELLED (with a reason) only before
 *     shipping, and both are final; the first promised date is set once;
 *   - a deposit request keeps its amount and moves only OPEN → PAID | WAIVED | CANCELLED;
 *   - the seed is idempotent.
 * The refusals are check_violation (SQLSTATE 23514); their messages are read through the scoped client's raw SQL.
 */

const DENIED = /permission denied/
const SALES = 'sales.prisma'
const DOCUMENT = 'a'.repeat(64)

let db: MigratedDatabase
let factory: FactoryDatabase
let a: CoreSeed
let b: CoreSeed
let productA: ProductSeed
let salesA: SalesSeed
let salesB: SalesSeed

const key = (namespace: string, name: string): string => seedUuid(namespace, name)
const A = {
  companyA: key('sales-a', 'company:A'),
  companyB: key('sales-a', 'company:B'),
  P1: key('sales-a', 'party:P1'),
  P3: key('sales-a', 'party:P3'),
  P4: key('sales-a', 'party:P4'),
  siteA: key('sales-a', 'site:A1'),
}
const B = { P1: key('sales-b', 'party:P1') }

const office = (seeded: CoreSeed): FactoryScope => ({ audience: 'office', tenantId: seeded.tenantId, actorId: seeded.actorId })
const partner = (partyId: string, seeded: CoreSeed = a): FactoryScope => ({ audience: 'partner', tenantId: seeded.tenantId, actorId: randomUUID(), partyId })
const floor = (): FactoryScope => ({ audience: 'floor', tenantId: a.tenantId, actorId: a.actorId, siteId: a.sites[0]!.id })
const as = <T>(scope: FactoryScope, work: (client: FactoryClient) => Promise<T>): Promise<T> => factory.withScope(scope, work)
const sql = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$queryRawUnsafe<Record<string, unknown>[]>(text, ...values))
const run = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$executeRawUnsafe(text, ...values))
const admin = async (text: string, values: unknown[] = []) => (await db.admin.query(text, values)).rows as Record<string, unknown>[]
const select = { id: true } as const

beforeAll(async () => {
  db = await migratedDatabase('sales')
  factory = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 4 } })
  a = await seedCore({ db: factory, namespace: 'sales-a' })
  b = await seedCore({ db: factory, namespace: 'sales-b' })
  productA = await seedProduct({ db: factory, namespace: 'sales-a' })
  salesA = await seedSales({ db: factory, namespace: 'sales-a' })
  salesB = await seedSales({ db: factory, namespace: 'sales-b' })
}, 60_000)

afterAll(async () => {
  await factory?.close()
  await db?.close()
}, 60_000)

interface DraftQuote {
  readonly quoteId: string
  readonly versionId: string
  readonly lineId: string
  readonly sizeId: string
}

/** A new DRAFT quote of tenant A's company A with one size-grid line (one jacket, size 52) and its size row. */
async function draftQuote(partyId: string, options: { noWithdrawal?: boolean } = {}): Promise<DraftQuote> {
  const ids = { quoteId: randomUUID(), versionId: randomUUID(), lineId: randomUUID(), sizeId: randomUUID() }
  await as(office(a), (client) =>
    client.$transaction(async (tx) => {
      await tx.quote.create({ data: { id: ids.quoteId, companyId: A.companyA, number: `T-${ids.quoteId.slice(0, 8)}`, partyId }, select })
      await tx.quoteVersion.create({
        data: { id: ids.versionId, quoteId: ids.quoteId, partyId, revision: 1, taxMode: 'IT_B2B', netAmount: 42_000, vatAmount: 9_240, grossAmount: 51_240, noWithdrawal: options.noWithdrawal ?? false },
        select,
      })
      await tx.quoteLine.create({
        data: {
          id: ids.lineId,
          versionId: ids.versionId,
          partyId,
          seq: 10,
          kind: 'SIZE_GRID',
          styleId: productA.styleId,
          colourwayId: productA.colourwayIds[0]!,
          quantity: 1,
          unitPrice: '420.000000',
          netAmount: 42_000,
          vatRatePct: '22.00',
          vatAmount: 9_240,
          unitCost: '300.500000',
        },
        select,
      })
      await tx.quoteLineSize.create({ data: { id: ids.sizeId, lineId: ids.lineId, partyId, size: '52', quantity: 1 }, select })
    }),
  )
  return ids
}

/** Sends a draft version (and its quote), as the send command does. */
async function send(quote: DraftQuote): Promise<void> {
  await run(
    office(a),
    `UPDATE "QuoteVersion" SET status = 'SENT', "sentAt" = now(), "validUntil" = current_date + 30, "documentSha256" = $2 WHERE id = $1::uuid`,
    quote.versionId,
    DOCUMENT,
  )
  await run(office(a), `UPDATE "Quote" SET status = 'SENT' WHERE id = $1::uuid`, quote.quoteId)
}


const acceptanceRow = (quote: DraftQuote, partyId: string, extra: Record<string, unknown> = {}) => ({
  id: randomUUID(),
  versionId: quote.versionId,
  partyId,
  channel: 'OFFICE' as const,
  signerName: 'Seed Signer',
  documentSha256: DOCUMENT,
  noWithdrawalAccepted: false,
  acceptedAt: new Date(),
  requestId: `test-${randomUUID()}`,
  ...extra,
})

/** Accepts a sent version and its quote with the acceptance row, in one transaction, as the accept command does. */
async function accept(scope: FactoryScope, quote: DraftQuote, partyId: string, evidence: Record<string, unknown> = {}): Promise<void> {
  await as(scope, (client) =>
    client.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`UPDATE "QuoteVersion" SET status = 'ACCEPTED', "closedAt" = now(), "decisionNote" = 'Agreed.' WHERE id = $1::uuid`, quote.versionId)
      await tx.$executeRawUnsafe(`UPDATE "Quote" SET status = 'ACCEPTED' WHERE id = $1::uuid`, quote.quoteId)
      await tx.quoteAcceptance.create({ data: acceptanceRow(quote, partyId, evidence), select })
    }),
  )
}

/** A new CONFIRMED order of tenant A from a new accepted quote of P1, with one size-grid line and its size row. */
async function confirmedOrder(): Promise<{ orderId: string; lineId: string; sizeId: string; versionId: string }> {
  const quote = await draftQuote(A.P1)
  await send(quote)
  await accept(office(a), quote, A.P1)
  const ids = { orderId: randomUUID(), lineId: randomUUID(), sizeId: randomUUID(), versionId: quote.versionId }
  await as(office(a), (client) =>
    client.$transaction(async (tx) => {
      await tx.salesOrder.create({
        data: {
          id: ids.orderId,
          companyId: A.companyA,
          partyId: A.P1,
          number: `T-SO-${ids.orderId.slice(0, 8)}`,
          quoteVersionId: quote.versionId,
          orderDate: new Date('2026-10-30T00:00:00.000Z'),
          taxMode: 'IT_B2B',
          billTo: { legalName: 'Seed Customer One S.r.l.' },
          shipTo: { line1: 'Via Esempio 12' },
          promiseDate: new Date('2026-12-18T00:00:00.000Z'),
          originalPromiseDate: new Date('2026-12-18T00:00:00.000Z'),
        },
        select,
      })
      await tx.salesOrderLine.create({
        data: {
          id: ids.lineId,
          companyId: A.companyA,
          orderId: ids.orderId,
          partyId: A.P1,
          seq: 10,
          kind: 'SIZE_GRID',
          styleId: productA.styleId,
          colourwayId: productA.colourwayIds[0]!,
          quantity: 1,
          unitPrice: '420.000000',
          netAmount: 42_000,
          vatRatePct: '22.00',
          vatAmount: 9_240,
          siteId: A.siteA,
        },
        select,
      })
      await tx.salesOrderLineSize.create({ data: { id: ids.sizeId, lineId: ids.lineId, partyId: A.P1, size: '52', quantity: 1 }, select })
    }),
  )
  return ids
}

describe('the partner wall', () => {
  const models = classifiedModels(loadSchema(), loadOwnership()).filter(({ model }) => model.file === SALES)

  it('reads only its own party’s quotes, versions, lines, acceptances, deposit requests and orders, with their prices', async () => {
    const other = await draftQuote(A.P3)
    const numbers = async (scope: FactoryScope) =>
      (await as(scope, (client) => client.quote.findMany({ select: { number: true }, orderBy: { number: 'asc' } }))).map((row) => row.number)
    expect(await numbers(partner(A.P1))).toEqual(['SEED-Q-0001', 'SEED-Q-0002'])
    expect(await numbers(partner(A.P3))).toEqual([`T-${other.quoteId.slice(0, 8)}`])
    expect(await numbers(partner(A.P4))).toEqual([])
    // Tenant B's customer: its own seeded quotes, never tenant A's.
    expect(await numbers(partner(B.P1, b))).toEqual(['SEED-Q-0001', 'SEED-Q-0002'])
    const lines = await as(partner(B.P1, b), (client) => client.quoteLine.findMany({ select: { versionId: true } }))
    expect(new Set(lines.map((line) => line.versionId))).toEqual(new Set([salesB.acceptedVersionId, salesB.draftVersionId]))

    // Its own document, with prices.
    const version = await as(partner(A.P1), (client) =>
      client.quoteVersion.findUniqueOrThrow({
        where: { id: salesA.acceptedVersionId },
        select: { status: true, netAmount: true, grossAmount: true, lines: { select: { unitPrice: true, sizes: { select: { size: true, quantity: true } } }, orderBy: { seq: 'asc' } } },
      }),
    )
    expect(version).toMatchObject({ status: 'ACCEPTED', netAmount: 504_000, grossAmount: 614_880 })
    expect(version.lines.map((line) => [line.unitPrice.toString(), line.sizes.length])).toEqual([
      ['420', 3],
      ['420', 3],
    ])
    for (const table of ['QuoteAcceptance', 'DepositRequest', 'SalesOrder', 'SalesOrderLine', 'SalesOrderLineSize']) {
      expect((await sql(partner(A.P1), `SELECT id FROM "${table}"`)).length, table).toBeGreaterThan(0)
      expect(await sql(partner(A.P3), `SELECT id FROM "${table}"`), table).toEqual([])
    }
  })

  it('never reads a cost, margin or internal column, nor who in the office wrote a row', async () => {
    const walled = models.flatMap(({ model, ownership }) => partnerWalledColumns(model).map(({ column }) => ({ model, ownership, column })))
    // Not vacuous: the line cost, the version's margin and the order's note are such columns.
    expect(walled.map(({ model, column }) => `${model.name}.${column}`)).toEqual(
      expect.arrayContaining(['QuoteLine.unitCost', 'QuoteLine.costSnapshot', 'QuoteVersion.marginPct', 'QuoteVersion.marginFloorBreached', 'SalesOrder.internalNote', 'Quote.lostReason']),
    )
    for (const { model, ownership, column } of walled) {
      const access = ownership.access[PARTNER_ROLE]
      if (access) expect(access.hiddenColumns ?? [], `${model.name}.${column}`).toContain(column)
      await expect(sql(partner(A.P1), `SELECT "${column}" FROM "${model.table}" LIMIT 1`), `${model.name}.${column}`).rejects.toThrow(DENIED)
      expect((await sql(office(a), `SELECT "${column}" FROM "${model.table}"`)).length, `${model.name}.${column} for the office`).toBeGreaterThan(0)
    }
    for (const { model, ownership } of models) {
      const access = ownership.access[PARTNER_ROLE]
      if (access && model.columns.includes('createdById')) expect(access.hiddenColumns, `${model.name}.createdById`).toContain('createdById')
    }
    await expect(sql(partner(A.P1), 'SELECT "sentById" FROM "QuoteVersion"')).rejects.toThrow(DENIED)
    // The approvals are the office's: the partner reads none.
    await expect(sql(partner(A.P1), 'SELECT id FROM "QuoteApproval"')).rejects.toThrow(DENIED)
    // Prisma's default select names every column, so a forgotten select fails loudly.
    await expect(as(partner(A.P1), (client) => client.quoteLine.findMany())).rejects.toThrow(DENIED)
  })

  it('the floor reads and writes nothing of sales', async () => {
    expect(models).toHaveLength(11)
    for (const { model, ownership } of models) {
      expect(ownership.access[FLOOR_ROLE], model.name).toBeUndefined()
      await expect(sql(floor(), `SELECT id FROM "${model.table}" LIMIT 1`), model.name).rejects.toThrow(DENIED)
    }
  })
})

describe('a quote version', () => {
  it('starts as DRAFT, and its lines change only while it is DRAFT', async () => {
    const quote = await draftQuote(A.P1)
    const asOffice = (text: string, ...values: unknown[]) => run(office(a), text, ...values)
    expect(await asOffice('UPDATE "QuoteLineSize" SET quantity = 2 WHERE id = $1::uuid', quote.sizeId)).toBe(1)

    // Asking for an approval freezes the lines; back to DRAFT they move again.
    await asOffice(`UPDATE "QuoteVersion" SET status = 'PENDING_APPROVAL' WHERE id = $1::uuid`, quote.versionId)
    await expect(asOffice('UPDATE "QuoteLine" SET "unitPrice" = 1 WHERE id = $1::uuid', quote.lineId)).rejects.toThrow(/is PENDING_APPROVAL; its lines change only while it is DRAFT/)
    await expect(asOffice('UPDATE "QuoteLineSize" SET quantity = 3 WHERE id = $1::uuid', quote.sizeId)).rejects.toThrow(/its size quantities change only while it is DRAFT/)
    await asOffice(`UPDATE "QuoteVersion" SET status = 'DRAFT' WHERE id = $1::uuid`, quote.versionId)
    expect(await asOffice('UPDATE "QuoteLineSize" SET quantity = 3 WHERE id = $1::uuid', quote.sizeId)).toBe(1)

    // Shapes: a size row belongs to a size-grid line; a made-to-measure unit is one piece with its profile.
    await expect(asOffice('UPDATE "QuoteLineSize" SET quantity = 0 WHERE id = $1::uuid', quote.sizeId)).rejects.toThrow(/has at least one piece/)
    await expect(asOffice(`UPDATE "QuoteLine" SET kind = 'MADE_TO_MEASURE' WHERE id = $1::uuid`, quote.lineId)).rejects.toThrow(/one made-to-measure unit with its measurement profile/)

    // A version is born DRAFT.
    await expect(
      asOffice(
        `INSERT INTO "QuoteVersion" (id, "quoteId", "partyId", revision, status, "taxMode", "sentAt", "validUntil", "documentSha256", "updatedAt") VALUES ($1::uuid, $2::uuid, $3::uuid, 2, 'SENT', 'IT_B2B', now(), current_date, $4, now())`,
        randomUUID(),
        quote.quoteId,
        A.P1,
        DOCUMENT,
      ),
    ).rejects.toThrow(/starts as DRAFT, not SENT/)
  })

  it('is sent only with its send time, validity and document hash, then changes only its decision', async () => {
    const quote = await draftQuote(A.P1)
    const asOffice = (text: string, ...values: unknown[]) => run(office(a), text, ...values)
    await expect(asOffice(`UPDATE "QuoteVersion" SET status = 'SENT', "sentAt" = now() WHERE id = $1::uuid`, quote.versionId)).rejects.toThrow(
      /is SENT without its send time, validity or document hash/,
    )
    await send(quote)
    for (const set of ['"netAmount" = 1', '"validUntil" = current_date + 90', '"termsText" = \'other terms\'', `"billTo" = '{}'::jsonb`, '"documentSha256" = NULL']) {
      await expect(asOffice(`UPDATE "QuoteVersion" SET ${set} WHERE id = $1::uuid`, quote.versionId), set).rejects.toThrow(/was sent; only its decision changes/)
    }
    await expect(asOffice(`UPDATE "QuoteVersion" SET status = 'DRAFT', "sentAt" = NULL WHERE id = $1::uuid`, quote.versionId)).rejects.toThrow(/cannot move from SENT to DRAFT/)
    await expect(asOffice('UPDATE "QuoteVersion" SET revision = 9 WHERE id = $1::uuid', quote.versionId)).rejects.toThrow(/never change/)
    // Its lines and sizes: no insert, change or removal.
    await expect(asOffice('UPDATE "QuoteLine" SET "unitPrice" = 1 WHERE id = $1::uuid', quote.lineId)).rejects.toThrow(/is SENT; its lines change only while it is DRAFT/)
    await expect(asOffice('DELETE FROM "QuoteLineSize" WHERE id = $1::uuid', quote.sizeId)).rejects.toThrow(/is SENT; its size quantities change/)
    await expect(
      asOffice(
        `INSERT INTO "QuoteLineSize" (id, "lineId", "partyId", size, quantity, "updatedAt") VALUES ($1::uuid, $2::uuid, $3::uuid, '54', 1, now())`,
        randomUUID(),
        quote.lineId,
        A.P1,
      ),
    ).rejects.toThrow(/is SENT; its size quantities change/)
    // A model call is refused too (its message aside).
    await expect(as(office(a), (client) => client.quoteVersion.update({ where: { id: quote.versionId }, data: { grossAmount: 1 }, select }))).rejects.toThrow()
    // For every login: the owner too.
    await expect(admin('UPDATE "QuoteVersion" SET "grossAmount" = 1 WHERE id = $1', [quote.versionId])).rejects.toThrow(/was sent; only its decision changes/)
    await expect(admin('DELETE FROM "QuoteVersion" WHERE id = $1', [quote.versionId])).rejects.toThrow(/it is kept, never deleted/)
    await expect(admin('TRUNCATE "QuoteLineSize"')).rejects.toThrow(/TRUNCATE on "QuoteLineSize" is refused/)

    // The decision: superseded by a newer version, then nothing changes any more.
    expect(await asOffice(`UPDATE "QuoteVersion" SET status = 'SUPERSEDED', "closedAt" = now() WHERE id = $1::uuid`, quote.versionId)).toBe(1)
    await expect(asOffice(`UPDATE "QuoteVersion" SET "decisionNote" = 'late note' WHERE id = $1::uuid`, quote.versionId)).rejects.toThrow(/is SUPERSEDED; it never changes/)
    // An UPDATE that changes nothing passes.
    expect(await asOffice('UPDATE "QuoteVersion" SET status = status WHERE id = $1::uuid', quote.versionId)).toBe(1)
  })

  it('a quote has at most one ACCEPTED version', async () => {
    const quote = await draftQuote(A.P1)
    await send(quote)
    await accept(office(a), quote, A.P1)
    // A second version of the same quote, sent and accepted: refused by the partial unique index.
    const second = randomUUID()
    await as(office(a), (client) => client.quoteVersion.create({ data: { id: second, quoteId: quote.quoteId, partyId: A.P1, revision: 2, taxMode: 'IT_B2B' }, select }))
    await run(office(a), `UPDATE "QuoteVersion" SET status = 'SENT', "sentAt" = now(), "validUntil" = current_date, "documentSha256" = $2 WHERE id = $1::uuid`, second, DOCUMENT)
    await expect(run(office(a), `UPDATE "QuoteVersion" SET status = 'ACCEPTED', "closedAt" = now() WHERE id = $1::uuid`, second)).rejects.toThrow(
      /QuoteVersion_one_accepted_per_quote|Unique constraint/,
    )
    // The seeded quote has its one accepted version.
    const [{ n }] = (await admin(`SELECT count(*)::int AS n FROM "QuoteVersion" WHERE "quoteId" = $1 AND status = 'ACCEPTED'`, [salesA.quoteId])) as [{ n: number }]
    expect(n).toBe(1)
  })
})

describe('the accept link (the partner role)', () => {
  it('accepts or declines its party’s SENT version and quote, and changes nothing else', async () => {
    const quote = await draftQuote(A.P1)
    const asPartner = (text: string, ...values: unknown[]) => run(partner(A.P1), text, ...values)
    // A draft: the partner changes nothing, not even a price it can read.
    await expect(asPartner('UPDATE "QuoteVersion" SET "netAmount" = 1 WHERE id = $1::uuid', quote.versionId)).rejects.toThrow(/only accepts or declines a SENT quote version/)
    await expect(asPartner(`UPDATE "Quote" SET status = 'SENT' WHERE id = $1::uuid`, quote.quoteId)).rejects.toThrow(/only accepts or declines a SENT quote/)
    await expect(asPartner('UPDATE "QuoteLine" SET "unitPrice" = 1 WHERE id = $1::uuid', quote.lineId)).rejects.toThrow(DENIED)
    await send(quote)
    await expect(asPartner(`UPDATE "QuoteVersion" SET status = 'EXPIRED', "closedAt" = now() WHERE id = $1::uuid`, quote.versionId)).rejects.toThrow(
      /only accepts or declines a SENT quote version/,
    )
    await expect(asPartner(`UPDATE "QuoteVersion" SET status = 'ACCEPTED', "closedAt" = now(), "grossAmount" = 1 WHERE id = $1::uuid`, quote.versionId)).rejects.toThrow(
      /was sent; only its decision changes/,
    )
    // Another party's link changes nothing (its rows are out of sight).
    expect(await run(partner(A.P3), `UPDATE "QuoteVersion" SET status = 'ACCEPTED', "closedAt" = now() WHERE id = $1::uuid`, quote.versionId)).toBe(0)

    // The accept command: version and quote ACCEPTED, then the evidence row through its link.
    const linkId = randomUUID()
    await as(office(a), (client) =>
      client.oneOffLink.create({
        data: {
          id: linkId,
          companyId: A.companyA,
          partyId: A.P1,
          purpose: 'QUOTE_ACCEPT',
          recordType: 'QuoteVersion',
          recordId: quote.versionId,
          tokenHash: randomUUID(),
          expiresAt: new Date(Date.now() + 86_400_000),
          maxUses: 1,
          createdById: a.actorId,
        },
        select,
      }),
    )
    await accept(partner(A.P1), quote, A.P1, { channel: 'LINK', linkId, emailCheck: 'MATCHED', signerName: 'Seed Buyer One' })
    const [row] = await admin('SELECT v.status::text AS version, q.status::text AS quote FROM "QuoteVersion" v JOIN "Quote" q ON q.id = v."quoteId" WHERE v.id = $1', [quote.versionId])
    expect(row).toEqual({ version: 'ACCEPTED', quote: 'ACCEPTED' })
    // Decided: the partner (and everyone) can change it no more.
    await expect(asPartner(`UPDATE "QuoteVersion" SET "decisionNote" = 'changed my mind' WHERE id = $1::uuid`, quote.versionId)).rejects.toThrow(/is ACCEPTED; it never changes/)
    await expect(asPartner(`UPDATE "Quote" SET status = 'DECLINED' WHERE id = $1::uuid`, quote.quoteId)).rejects.toThrow(/cannot move from ACCEPTED to DECLINED/)
  })
})

describe('an acceptance', () => {
  it('is append-only, for every login', async () => {
    const [{ id }] = (await admin('SELECT id::text AS id FROM "QuoteAcceptance" WHERE "versionId" = $1', [salesA.acceptedVersionId])) as [{ id: string }]
    await expect(run(office(a), `UPDATE "QuoteAcceptance" SET "signerName" = 'x' WHERE id = $1::uuid`, id)).rejects.toThrow(DENIED)
    await expect(run(office(a), 'DELETE FROM "QuoteAcceptance" WHERE id = $1::uuid', id)).rejects.toThrow(DENIED)
    await expect(run(partner(A.P1), `UPDATE "QuoteAcceptance" SET "signerName" = 'x' WHERE id = $1::uuid`, id)).rejects.toThrow(DENIED)
    await expect(admin(`UPDATE "QuoteAcceptance" SET "signerName" = 'x' WHERE id = $1`, [id])).rejects.toThrow(/append-only: UPDATE on "QuoteAcceptance" is refused/)
    await expect(admin('DELETE FROM "QuoteAcceptance" WHERE id = $1', [id])).rejects.toThrow(/append-only: DELETE on "QuoteAcceptance" is refused/)
    await expect(admin('TRUNCATE "QuoteAcceptance"')).rejects.toThrow(/append-only: TRUNCATE on "QuoteAcceptance" is refused/)
  })

  it('is written in the transaction that accepts its version: an ACCEPTED version without one is refused at commit', async () => {
    const quote = await draftQuote(A.P1)
    await send(quote)
    await expect(run(office(a), `UPDATE "QuoteVersion" SET status = 'ACCEPTED', "closedAt" = now() WHERE id = $1::uuid`, quote.versionId)).rejects.toThrow(
      /is ACCEPTED without its acceptance/,
    )
    const [row] = await admin('SELECT status::text AS status FROM "QuoteVersion" WHERE id = $1', [quote.versionId])
    expect(row).toEqual({ status: 'SENT' })
  })

  it('names an ACCEPTED version, its document, and a consumer’s acceptance of no withdrawal', async () => {
    const insert = (row: Record<string, unknown>) =>
      run(
        office(a),
        `INSERT INTO "QuoteAcceptance" SELECT * FROM jsonb_populate_record(NULL::"QuoteAcceptance", $1::jsonb)`,
        JSON.stringify({ tenantId: a.tenantId, createdAt: new Date(), ...row }),
      )
    // A version for the private rider P4 that states there is no right of withdrawal (a made-to-measure unit).
    const quote = await draftQuote(A.P4, { noWithdrawal: true })
    await send(quote)
    await expect(insert(acceptanceRow(quote, A.P4))).rejects.toThrow(/which is SENT, not ACCEPTED/)
    // Without the consumer's acceptance of that statement the accept fails as a whole; with it, it holds.
    await expect(accept(office(a), quote, A.P4)).rejects.toThrow(/must record that it was accepted/)
    await accept(office(a), quote, A.P4, { noWithdrawalAccepted: true })
    await expect(insert(acceptanceRow(quote, A.P4, { documentSha256: 'b'.repeat(64), noWithdrawalAccepted: true }))).rejects.toThrow(/names another document/)
    await expect(insert(acceptanceRow(quote, A.P4))).rejects.toThrow(/no right of withdrawal; .* must record that it was accepted \(Codice del Consumo art\. 59\(c\)\)/)
    await expect(insert(acceptanceRow(quote, A.P4, { channel: 'LINK', noWithdrawalAccepted: true }))).rejects.toThrow(/names its link and email check exactly when/)
    await expect(insert(acceptanceRow(quote, A.P4, { signerName: '  ', noWithdrawalAccepted: true }))).rejects.toThrow(/names who accepted/)
    expect(await insert(acceptanceRow(quote, A.P4, { noWithdrawalAccepted: true }))).toBe(1)
  })
})

describe('a sales order', () => {
  it('is made only from an ACCEPTED version of a quote of its own company', async () => {
    const quote = await draftQuote(A.P1)
    const insert = (versionId: string, companyId: string) =>
      run(
        office(a),
        `INSERT INTO "SalesOrder" (id, "companyId", "partyId", number, "quoteVersionId", "orderDate", "taxMode", "billTo", "shipTo", "updatedAt")
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::uuid, current_date, 'IT_B2B', '{}', '{}', now())`,
        randomUUID(),
        companyId,
        A.P1,
        `T-SO-${randomUUID().slice(0, 8)}`,
        versionId,
      )
    await expect(insert(quote.versionId, A.companyA)).rejects.toThrow(/made only from an ACCEPTED version of a quote of its own company/)
    await expect(insert(salesA.acceptedVersionId, A.companyB)).rejects.toThrow(/made only from an ACCEPTED version of a quote of its own company/)
    expect(await insert(salesA.acceptedVersionId, A.companyA)).toBe(1)
  })

  it('changes its lines only while CONFIRMED, IN_PRODUCTION or READY', async () => {
    const order = await confirmedOrder()
    const asOffice = (text: string, ...values: unknown[]) => run(office(a), text, ...values)
    const status = (to: string) => asOffice(`UPDATE "SalesOrder" SET status = '${to}' WHERE id = $1::uuid`, order.orderId)
    for (const state of ['CONFIRMED', 'IN_PRODUCTION', 'READY']) {
      if (state !== 'CONFIRMED') await status(state)
      expect(await asOffice('UPDATE "SalesOrderLineSize" SET quantity = quantity + 1 WHERE id = $1::uuid', order.sizeId), state).toBe(1)
    }
    await status('PARTLY_SHIPPED')
    await expect(asOffice('UPDATE "SalesOrderLine" SET "unitPrice" = 1 WHERE id = $1::uuid', order.lineId)).rejects.toThrow(
      /is PARTLY_SHIPPED; its lines change only while it is CONFIRMED, IN_PRODUCTION or READY/,
    )
    await expect(asOffice('DELETE FROM "SalesOrderLineSize" WHERE id = $1::uuid', order.sizeId)).rejects.toThrow(/is PARTLY_SHIPPED; its size quantities change only/)
    await expect(
      asOffice(
        `INSERT INTO "SalesOrderLineSize" (id, "lineId", "partyId", size, quantity, "updatedAt") VALUES ($1::uuid, $2::uuid, $3::uuid, '54', 1, now())`,
        randomUUID(),
        order.lineId,
        A.P1,
      ),
    ).rejects.toThrow(/is PARTLY_SHIPPED; its size quantities change only/)
    // Cancelling after something shipped is refused; closing comes from SHIPPED only.
    await expect(asOffice(`UPDATE "SalesOrder" SET status = 'CANCELLED', "cancelReason" = 'x', "closedAt" = now() WHERE id = $1::uuid`, order.orderId)).rejects.toThrow(
      /cannot move from PARTLY_SHIPPED to CANCELLED/,
    )
    await expect(asOffice(`UPDATE "SalesOrder" SET status = 'CLOSED', "closedAt" = now() WHERE id = $1::uuid`, order.orderId)).rejects.toThrow(
      /cannot move from PARTLY_SHIPPED to CLOSED/,
    )
    await status('SHIPPED')
    await expect(asOffice(`UPDATE "SalesOrder" SET status = 'CLOSED' WHERE id = $1::uuid`, order.orderId)).rejects.toThrow(/is CLOSED with the wrong closing time/)
    expect(await asOffice(`UPDATE "SalesOrder" SET status = 'CLOSED', "closedAt" = now() WHERE id = $1::uuid`, order.orderId)).toBe(1)
    await expect(asOffice(`UPDATE "SalesOrder" SET "internalNote" = 'after close' WHERE id = $1::uuid`, order.orderId)).rejects.toThrow(/is CLOSED; it never changes/)
    await expect(admin('DELETE FROM "SalesOrder" WHERE id = $1', [order.orderId])).rejects.toThrow(/is cancelled, never deleted/)
  })

  it('is cancelled with a reason before anything shipped, keeps its first promised date, and is final', async () => {
    const order = await confirmedOrder()
    const asOffice = (text: string, ...values: unknown[]) => run(office(a), text, ...values)
    await expect(asOffice(`UPDATE "SalesOrder" SET "originalPromiseDate" = '2027-01-15' WHERE id = $1::uuid`, order.orderId)).rejects.toThrow(/first promised date .* is set once/)
    expect(await asOffice(`UPDATE "SalesOrder" SET "promiseDate" = '2027-01-15' WHERE id = $1::uuid`, order.orderId)).toBe(1)
    await expect(asOffice(`UPDATE "SalesOrder" SET number = 'X-1' WHERE id = $1::uuid`, order.orderId)).rejects.toThrow(/never change/)
    await expect(asOffice(`UPDATE "SalesOrder" SET status = 'CANCELLED', "closedAt" = now() WHERE id = $1::uuid`, order.orderId)).rejects.toThrow(
      /has a cancel reason exactly when it is CANCELLED/,
    )
    expect(await asOffice(`UPDATE "SalesOrder" SET status = 'CANCELLED', "cancelReason" = 'Customer withdrew', "closedAt" = now() WHERE id = $1::uuid`, order.orderId)).toBe(1)
    await expect(asOffice(`UPDATE "SalesOrder" SET status = 'CONFIRMED', "cancelReason" = NULL, "closedAt" = NULL WHERE id = $1::uuid`, order.orderId)).rejects.toThrow(
      /is CANCELLED; it never changes/,
    )
    await expect(asOffice('UPDATE "SalesOrderLine" SET quantity = 2 WHERE id = $1::uuid', order.lineId)).rejects.toThrow(/is CANCELLED; its lines change only/)
  })
})

describe('a deposit request', () => {
  it('keeps its amount and moves only OPEN → PAID | WAIVED | CANCELLED', async () => {
    const asOffice = (text: string, ...values: unknown[]) => run(office(a), text, ...values)
    const id = salesA.depositRequestId
    await expect(asOffice('UPDATE "DepositRequest" SET amount = 1 WHERE id = $1::uuid', id)).rejects.toThrow(/the amount, currency, kind, fiscal decision, party and version .* never change/)
    await expect(asOffice(`UPDATE "DepositRequest" SET "fiscalDocument" = 'NONE' WHERE id = $1::uuid`, id)).rejects.toThrow(/never change/)
    await expect(asOffice(`UPDATE "DepositRequest" SET "orderId" = NULL WHERE id = $1::uuid`, id)).rejects.toThrow(/is named once/)
    await expect(asOffice(`UPDATE "DepositRequest" SET status = 'PAID' WHERE id = $1::uuid`, id)).rejects.toThrow(/is PAID with the wrong payment time/)
    expect(await asOffice(`UPDATE "DepositRequest" SET "dueDate" = "dueDate" + 7 WHERE id = $1::uuid`, id)).toBe(1)
    expect(await asOffice(`UPDATE "DepositRequest" SET status = 'PAID', "paidAt" = now() WHERE id = $1::uuid`, id)).toBe(1)
    await expect(asOffice(`UPDATE "DepositRequest" SET status = 'OPEN', "paidAt" = NULL WHERE id = $1::uuid`, id)).rejects.toThrow(/is PAID; it never changes/)
    await expect(admin('DELETE FROM "DepositRequest" WHERE id = $1', [id])).rejects.toThrow(/is cancelled, never deleted/)
  })
})

describe('the seed', () => {
  it('is idempotent', async () => {
    const tables = ['Quote', 'QuoteVersion', 'QuoteLine', 'QuoteLineSize', 'QuoteApproval', 'QuoteAcceptance', 'DepositRequest', 'SalesOrder', 'SalesOrderLine', 'SalesOrderLineSize']
    // QuoteAcceptance is append-only and has no updatedAt.
    const stamp = (table: string) => (table === 'QuoteAcceptance' ? 'createdAt' : 'updatedAt')
    const snapshot = async () =>
      Promise.all(tables.map(async (table) => (await admin(`SELECT count(*)::int AS n, max("${stamp(table)}")::text AS at FROM "${table}" WHERE "tenantId" = $1`, [b.tenantId]))[0]))
    const before = await snapshot()
    expect(await seedSales({ db: factory, namespace: 'sales-b' })).toEqual(salesB)
    expect(await snapshot()).toEqual(before)
    // Q1 went through to its order; Q2 is a draft whose rows sort first (the generated isolation tests copy them).
    const [order] = await admin('SELECT status::text AS status, "quoteVersionId"::text AS version FROM "SalesOrder" WHERE id = $1', [salesB.orderId])
    expect(order).toEqual({ status: 'CONFIRMED', version: salesB.acceptedVersionId })
    for (const table of ['QuoteVersion', 'QuoteLine', 'QuoteLineSize']) {
      const [first] = await admin(`SELECT id::text AS id FROM "${table}" WHERE "tenantId" = $1 ORDER BY id LIMIT 1`, [b.tenantId])
      expect(String(first!.id), table).toMatch(/^00000000-/)
    }
  })
})
