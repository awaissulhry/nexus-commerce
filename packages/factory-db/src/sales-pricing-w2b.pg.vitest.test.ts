import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { seed as seedCore, type CoreSeed } from '../seed/_core'
import { seed as seedReasons } from '../seed/reasons'
import { seed as seedSalesPricing, type SalesPricingSeed } from '../seed/sales-pricing'
import { openFactoryDatabase, type FactoryClient, type FactoryDatabase, type FactoryScope } from './client'
import { RUNTIME_LOGIN } from './roles'
import { seedUuid } from './seeding'
import { migratedDatabase, type MigratedDatabase } from './testing/database'

/**
 * Quotes, pricing and configuration (W2b-5, schema wave 38/44, B-W2b-280, …_sales_pricing_w2b_guards) on a database built from
 * the migrations and seeded, through the real login and the scoped client:
 *   - the rows made before the wave keep W1's ways (signed acceptance, no Incoterm, no waterfall, no fee kind) and the seed's
 *     waterfalls add up;
 *   - quote templates and their lines; a quote's template named once;
 *   - a version's Incoterm, acceptance mode and reminder (the one more change a SENT version takes; never by a partner);
 *   - the price waterfall: adding up to the unit price, its start, its sources and reasons, dropped when a price changes
 *     without it;
 *   - FEE lines; delivery schedules and chosen options as parts of their line (state, sizes, free text, surcharge);
 *   - quantity breaks, size surcharges, an entry's dated validity, minimum order rules, size curves, margin floors by role;
 *   - a work order cell's option values; what a partner session reads.
 * The refusals are check_violation (23514); their messages are read through raw SQL.
 */

const NS = 'w2b-280-a'

let db: MigratedDatabase
let factory: FactoryDatabase
let a: CoreSeed
let s: SalesPricingSeed

const key = (name: string): string => seedUuid(NS, name)
const firstKey = (name: string): string => `00000000${key(name).slice(8)}`
const A = { company: key('company:A'), companyB: key('company:B'), P1: key('party:P1') }
const office = (): FactoryScope => ({ audience: 'office', tenantId: a.tenantId, actorId: a.actorId })
const partner = (): FactoryScope => ({ audience: 'partner', tenantId: a.tenantId, actorId: randomUUID(), partyId: A.P1 })
const as = <T>(scope: FactoryScope, work: (client: FactoryClient) => Promise<T>): Promise<T> => factory.withScope(scope, work)
const run = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$executeRawUnsafe(text, ...values))
const sql = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$queryRawUnsafe<Record<string, unknown>[]>(text, ...values))
const admin = async (text: string, values: unknown[] = []) => (await db.admin.query(text, values)).rows as Record<string, unknown>[]
const one = async (text: string, values: unknown[] = []) => (await admin(text, values))[0]!
/** INSERT a copy of row `id` of `table` with `changes` (a jsonb object of columns). */
const copyRow = (scope: FactoryScope, table: string, id: string, changes: Record<string, unknown>) =>
  run(scope, `INSERT INTO "${table}" SELECT * FROM jsonb_populate_record(NULL::"${table}", (SELECT to_jsonb(r) || $1::jsonb FROM "${table}" r WHERE r.id = $2::uuid))`, JSON.stringify(changes), id)
/** UPDATE row `id` of `table`: `set` is the SET list. */
const update = (scope: FactoryScope, table: string, id: string, set: string, ...values: unknown[]) => run(scope, `UPDATE "${table}" SET ${set} WHERE id = $1::uuid`, id, ...values)
const remove = (scope: FactoryScope, table: string, id: string) => run(scope, `DELETE FROM "${table}" WHERE id = $1::uuid`, id)
const json = (value: unknown) => JSON.stringify(value)
let seq = 900

/** A new DRAFT line on SEED-Q-0003 (a copy of its configured grid line, without its parts), with its sizes 50 × 2, 52 × 4, 54 × 2. */
async function draftLine(changes: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID()
  seq += 10
  expect(await copyRow(office(), 'QuoteLine', s.draftQuote.gridLineId, { id, seq, ...changes })).toBe(1)
  if ((changes.kind ?? 'SIZE_GRID') === 'SIZE_GRID') {
    for (const [size, quantity] of [['50', 2], ['52', 4], ['54', 2]] as const) {
      expect(await run(office(), `INSERT INTO "QuoteLineSize" (id, "lineId", "partyId", size, quantity) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5)`, randomUUID(), id, A.P1, size, quantity)).toBe(1)
    }
  }
  return id
}
/** A delivery of quote line `lineId`. */
const delivery = (lineId: string, date: string, sizes: Record<string, number> | null, quantity: number, table = 'QuoteLineDelivery') =>
  run(office(), `INSERT INTO "${table}" (id, "lineId", "partyId", "deliveryDate", "sizeQuantities", quantity) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::date, $5::jsonb, $6)`, randomUUID(), lineId, A.P1, date, sizes === null ? null : json(sizes), quantity)
/** An option chosen on quote line `lineId` (a copy of SEED-Q-0003's liner option). */
const option = (lineId: string, changes: Record<string, unknown> = {}, table = 'QuoteLineOption', from?: string) =>
  copyRow(office(), table, from ?? firstKey('sales-pricing:Q3:option:ARMOUR'), { id: randomUUID(), lineId, ...changes })

beforeAll(async () => {
  db = await migratedDatabase('salesprcw2b')
  factory = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 4 } })
  a = await seedCore({ db: factory, namespace: NS })
  s = await seedSalesPricing({ db: factory, namespace: NS })
  await seedReasons({ db: factory, namespace: NS })
}, 300_000)

afterAll(async () => {
  await factory?.close()
  await db?.close()
}, 60_000)

describe('the rows made before the wave and the seed', () => {
  it('keeps W1 quotes signed, without Incoterm, fee kind or waterfall, and the seed adds up', async () => {
    const older = await admin(
      `SELECT count(*)::int AS n FROM "QuoteVersion" v JOIN "Quote" q ON q.id = v."quoteId"
        WHERE v."tenantId" = $1 AND q.number IN ('SEED-Q-0001', 'SEED-Q-0002')
          AND (v."acceptanceMode" <> 'SIGN' OR v.incoterm IS NOT NULL OR v."reminderSentAt" IS NOT NULL OR v."shipComplete" OR q."templateId" IS NOT NULL)`,
      [a.tenantId],
    )
    expect(older).toEqual([{ n: 0 }])
    expect(await one(`SELECT count(*)::int AS n FROM "QuoteLine" WHERE "tenantId" = $1 AND ("priceSteps" IS NOT NULL OR "feeKind" IS NOT NULL) AND "versionId" NOT IN ($2, $3)`, [a.tenantId, s.draftQuote.versionId, s.sentQuote.versionId])).toEqual({ n: 0 })
    // Every seeded waterfall is a reading of its line's price.
    const problems = await admin(
      `SELECT id, "factory_price_steps_problem"("priceSteps", "unitPrice", "listUnitPrice") AS problem FROM "QuoteLine" WHERE "tenantId" = $1 AND "priceSteps" IS NOT NULL
       UNION ALL SELECT id, "factory_price_steps_problem"("priceSteps", "unitPrice", NULL) FROM "SalesOrderLine" WHERE "tenantId" = $1 AND "priceSteps" IS NOT NULL`,
      [a.tenantId],
    )
    expect(problems.length).toBe(3)
    expect(problems.map((row) => row.problem)).toEqual([null, null, null])
    expect(await one(`SELECT "reminderSentAt" IS NOT NULL AS reminded, status::text AS status FROM "QuoteVersion" WHERE id = $1`, [s.sentQuote.versionId])).toEqual({ reminded: true, status: 'SENT' })
    // The PRICE_ADJUSTMENT list has its standard reasons (factory-domain reasons/standard).
    const codes = (await admin(`SELECT code FROM "ReasonCode" WHERE "tenantId" = $1 AND list = 'PRICE_ADJUSTMENT' ORDER BY "sortOrder", code`, [a.tenantId])).map((row) => row.code)
    expect(codes).toEqual(expect.arrayContaining(['LOYALTY', 'COMPETITION', 'VOLUME', 'GOODWILL', 'REWORK', 'TARGET_PRICE', 'OTHER']))
  })
})

describe('quote templates', () => {
  it('keeps a template\'s company, asks a deposit of a paid acceptance, names an Incoterm with its place, and is never deleted', async () => {
    const id = randomUUID()
    expect(await copyRow(office(), 'QuoteTemplate', s.templateIds.season, { id, name: 'Test template' })).toBe(1)
    await expect(update(office(), 'QuoteTemplate', id, `"companyId" = NULL`)).rejects.toThrow(/company and creation of quote template .* never change/)
    await expect(update(office(), 'QuoteTemplate', id, `"depositPct" = NULL, "depositKind" = NULL`)).rejects.toThrow(/is accepted by paying \(SIGN_AND_PAY\), so it asks a deposit/)
    await expect(update(office(), 'QuoteTemplate', id, `"depositKind" = NULL`)).rejects.toThrow(/deposit above 0 and at most 100 percent with its kind, or none/)
    await expect(update(office(), 'QuoteTemplate', id, `"incotermPlace" = NULL`)).rejects.toThrow(/Incoterm .* with its place .*, or neither/)
    await expect(update(office(), 'QuoteTemplate', id, `incoterm = 'exw'`)).rejects.toThrow(/Incoterm \(three capitals/)
    await expect(update(office(), 'QuoteTemplate', id, `"validityDays" = 400`)).rejects.toThrow(/stands 1 to 365 days/)
    await expect(update(office(), 'QuoteTemplate', id, `name = 'Two' || chr(10) || 'lines'`)).rejects.toThrow(/name of one line/)
    expect(await update(office(), 'QuoteTemplate', id, `"acceptanceMode" = 'SIGN', "depositPct" = NULL, "depositKind" = NULL, status = 'ARCHIVED'`)).toBe(1)
    // Payment terms of another company: refused.
    const terms = randomUUID()
    const termsOfA = (await one(`SELECT "paymentTermsId"::text AS id FROM "QuoteTemplate" WHERE id = $1`, [s.templateIds.season])).id as string
    expect(await copyRow(office(), 'PaymentTerms', termsOfA, { id: terms, code: `T-${terms.slice(0, 8)}`, companyId: A.companyB })).toBe(1)
    await expect(update(office(), 'QuoteTemplate', id, `"paymentTermsId" = $2::uuid`, terms)).rejects.toThrow(/payment terms of its own company or tenant-wide/)
    // Never deleted: the owner's own delete is refused too (no runtime role has the grant).
    await expect(db.admin.query(`DELETE FROM "QuoteTemplate" WHERE id = $1`, [id])).rejects.toThrow(/kept, never deleted \(archive it\)/)
    await expect(remove(office(), 'QuoteTemplate', id)).rejects.toThrow(/permission denied/)
  })

  it('holds size grid and fee lines of the template\'s company\'s styles, never a made-to-measure one', async () => {
    const first = firstKey('sales-pricing:template:SEASON:10')
    const copy = (changes: Record<string, unknown>) => copyRow(office(), 'QuoteTemplateLine', first, { id: randomUUID(), seq: (seq += 1), ...changes })
    await expect(copy({ kind: 'MADE_TO_MEASURE' })).rejects.toThrow(/a size grid or a fee \(a template has no rider/)
    await expect(copy({ kind: 'FEE' })).rejects.toThrow(/fee kind exactly when it is a FEE line/)
    await expect(copy({ kind: 'FEE', feeKind: 'SAMPLE' })).rejects.toThrow(/is a fee: it has no sizes/)
    await expect(copy({ feeKind: 'SAMPLE' })).rejects.toThrow(/fee kind exactly when it is a FEE line/)
    await expect(copy({ sizeQuantities: { '50': 0 } })).rejects.toThrow(/size 50 takes a whole number of pieces from 1 to 100000/)
    await expect(copy({ sizeQuantities: { '50': '2' } })).rejects.toThrow(/whole number of pieces/)
    await expect(copy({ sizeQuantities: { 'x y': 2 } })).rejects.toThrow(/is not a size code/)
    await expect(copy({ unitPrice: '0' })).rejects.toThrow(/price above 0/)
    await expect(copy({ seq: 0 })).rejects.toThrow(/its place from 1/)
    expect(await copy({ kind: 'FEE', feeKind: 'TOOLING', sizeQuantities: null, unitPrice: '80.000000' })).toBe(1)
    // A style of another company on a template of company A: refused.
    const style = randomUUID()
    const jkt01 = (await one(`SELECT "styleId"::text AS id FROM "QuoteTemplateLine" WHERE id = $1`, [first])).id as string
    expect(await copyRow(office(), 'Style', jkt01, { id: style, code: `T-STY-${style.slice(0, 6)}`, companyId: A.companyB })).toBe(1)
    await expect(copy({ styleId: style, colourwayId: null })).rejects.toThrow(/style of another company/)
    // The template never moves.
    await expect(update(office(), 'QuoteTemplateLine', first, `"templateId" = $2::uuid, seq = 777`, s.templateIds.samples)).rejects.toThrow(/never moves to another template/)
  })

  it('names a quote\'s template once, an ACTIVE one of the quote\'s company or of every company', async () => {
    const quote = randomUUID()
    expect(await copyRow(office(), 'Quote', s.draftQuote.quoteId, { id: quote, number: `T-Q-${quote.slice(0, 8)}`, templateId: s.templateIds.samples })).toBe(1)
    await expect(update(office(), 'Quote', quote, `"templateId" = $2::uuid`, s.templateIds.season)).rejects.toThrow(/named when it is made, never changed/)
    await expect(update(office(), 'Quote', quote, `"templateId" = NULL`)).rejects.toThrow(/never changed/)
    const archived = randomUUID()
    expect(await copyRow(office(), 'QuoteTemplate', s.templateIds.samples, { id: archived, status: 'ARCHIVED' })).toBe(1)
    await expect(copyRow(office(), 'Quote', s.draftQuote.quoteId, { id: randomUUID(), number: `T-Q-${randomUUID().slice(0, 8)}`, templateId: archived })).rejects.toThrow(/starts from an ACTIVE template of its own company or of every company/)
    await expect(copyRow(office(), 'Quote', s.draftQuote.quoteId, { id: randomUUID(), number: `T-Q-${randomUUID().slice(0, 8)}`, companyId: A.companyB, templateId: s.templateIds.season })).rejects.toThrow(/ACTIVE template of its own company/)
  })
})

describe('a version: Incoterm, acceptance mode, reminder', () => {
  it('names an Incoterm with its place and asks a deposit of a paid acceptance', async () => {
    const version = s.draftQuote.versionId
    await expect(update(office(), 'QuoteVersion', version, `"incotermPlace" = NULL`)).rejects.toThrow(/names an Incoterm .* with its place .*, or neither/)
    await expect(update(office(), 'QuoteVersion', version, `incoterm = 'EX'`)).rejects.toThrow(/three capitals/)
    await expect(update(office(), 'QuoteVersion', version, `"depositPct" = NULL`)).rejects.toThrow(/is accepted by paying \(SIGN_AND_PAY\), so it asks a deposit/)
    await expect(update(office(), 'QuoteVersion', version, `"reminderSentAt" = now()`)).rejects.toThrow(/is DRAFT: a customer is reminded only of a SENT version/)
    expect(await update(office(), 'QuoteVersion', version, `incoterm = 'FCA', "incotermPlace" = 'Seedville airport'`)).toBe(1)
    await expect(update(office(), 'SalesOrder', s.order.orderId, `incoterm = 'DAP', "incotermPlace" = NULL`)).rejects.toThrow(/sales order .* names an Incoterm/)
  })

  it('lets a SENT version take its reminder (later, never cleared, after the send, not by a partner) and nothing else new', async () => {
    const version = s.sentQuote.versionId
    const before = (await one(`SELECT "reminderSentAt" AS at FROM "QuoteVersion" WHERE id = $1`, [version])).at as Date
    await expect(update(office(), 'QuoteVersion', version, `"reminderSentAt" = NULL`)).rejects.toThrow(/only moves later, never cleared/)
    await expect(update(office(), 'QuoteVersion', version, `"reminderSentAt" = $2::timestamptz`, new Date(before.getTime() - 60_000))).rejects.toThrow(/only moves later/)
    await expect(update(office(), 'QuoteVersion', version, `"reminderSentAt" = now() + interval '1 day'`)).rejects.toThrow(/after its send and not in the future/)
    await expect(update(partner(), 'QuoteVersion', version, `"reminderSentAt" = now()`)).rejects.toThrow(/partner session only accepts or declines|only the office reminds/)
    // W1's freeze still holds for every other column of a SENT version, the new ones included.
    await expect(update(office(), 'QuoteVersion', version, `incoterm = 'EXW'`)).rejects.toThrow(/was sent; only its decision changes/)
    await expect(update(office(), 'QuoteVersion', version, `"shipComplete" = true`)).rejects.toThrow(/was sent; only its decision changes/)
    expect(await update(office(), 'QuoteVersion', version, `"reminderSentAt" = now()`)).toBe(1)
    // Once decided, frozen: the reminder too.
    expect(await update(office(), 'QuoteVersion', version, `status = 'EXPIRED', "closedAt" = now()`)).toBe(1)
    await expect(update(office(), 'QuoteVersion', version, `"reminderSentAt" = now()`)).rejects.toThrow(/is EXPIRED; it never changes/)
  })
})

describe('the price waterfall', () => {
  const steps = (net: string, extra: Record<string, unknown>[] = []): Record<string, unknown>[] => [
    { kind: 'LIST', unitPrice: '450.000000', source: { type: 'PriceListEntry', id: randomUUID() } },
    { kind: 'BREAK', delta: '-20.000000', unitPrice: '430.000000', source: { type: 'PriceBreak', id: randomUUID() } },
    ...extra,
    { kind: 'NET', unitPrice: net },
  ]

  it('adds up from its start to NET, the line\'s unit price, with every step\'s source or reason', async () => {
    const line = await draftLine({ listUnitPrice: '450.000000', unitPrice: '430.000000', priceSteps: null })
    const write = (value: unknown) => update(office(), 'QuoteLine', line, `"priceSteps" = $2::jsonb`, json(value))
    expect(await write(steps('430.000000'))).toBe(1)
    await expect(write(steps('431.000000'))).rejects.toThrow(/NET says 431.000000 but the steps reach 430.000000/)
    await expect(write(steps('430.000000').map((step, i) => (i === 0 ? { ...step, unitPrice: '440.000000' } : step)))).rejects.toThrow(/starts at 440.000000, not at the line's list price 450.000000/)
    await expect(write(steps('430.000000', [{ kind: 'MANUAL', delta: '-5.000000', unitPrice: '425.000000' }]))).rejects.toThrow(/names its reason code/)
    await expect(write(steps('425.000000', [{ kind: 'MANUAL', delta: '-5.000000', unitPrice: '425.000000', reasonCode: 'COMPETITION' }]))).rejects.toThrow(/NET 425.000000 is not the line's unit price 430.000000/)
    await expect(write(steps('430.000000', [{ kind: 'OPTION', delta: '10.000000', unitPrice: '440.000000' }]))).rejects.toThrow(/name their source/)
    await expect(write(steps('430.000000', [{ kind: 'DISCOUNT', delta: '-10.000000', unitPrice: '420.000000' }]))).rejects.toThrow(/a discount says its percent/)
    await expect(write(steps('430.000000', [{ kind: 'MANUAL', delta: '-5.000000', unitPrice: '424.000000', reasonCode: 'VOLUME' }]))).rejects.toThrow(/430.000000 - 5.000000 makes 425.000000, not 424.000000/)
    await expect(write(steps('430.000000', [{ kind: 'MANUAL', delta: 0, unitPrice: '430.000000', reasonCode: 'VOLUME' }]))).rejects.toThrow(/its delta is a decimal string, never 0/)
    await expect(write(steps('430.000000', [{ kind: 'SIZE_SURCHARGE', sizes: { '56': '20.000000' } }]))).rejects.toThrow(/name their source/)
    await expect(write(steps('430.000000', [{ kind: 'SIZE_SURCHARGE', sizes: { '56': '20.000000' }, delta: '1.000000', source: { type: 'SizeSurcharge', id: randomUUID() } }]))).rejects.toThrow(/beside the running price/)
    await expect(write([{ kind: 'NET', unitPrice: '430.000000' }, { kind: 'NET', unitPrice: '430.000000' }])).rejects.toThrow(/starts with LIST/)
    await expect(write(steps('430.000000', [{ kind: 'LIST', unitPrice: '430.000000', source: { type: 'PriceListEntry', id: randomUUID() } }]))).rejects.toThrow(/only the first step is the start/)
    await expect(write(steps('430.000000').map((step, i) => (i === 1 ? { ...step, colour: 'red' } : step)))).rejects.toThrow(/a field the waterfall does not know/)
    await expect(write(steps('430.000000').map((step, i) => (i === 1 ? { ...step, source: { type: 'PriceBreak', id: 'nope' } } : step)))).rejects.toThrow(/its source is \{ "type": a record type, "id": a UUID \}/)
    await expect(write({ steps: [] })).rejects.toThrow(/a list of steps/)
    // Size surcharges sit beside the running price; a discount and a manual change with their percent and reason.
    expect(
      await write(
        steps('430.000000', [
          { kind: 'SIZE_SURCHARGE', sizes: { '54': '21.500000' }, source: { type: 'SizeSurcharge', id: randomUUID() } },
          { kind: 'DISCOUNT', delta: '-21.500000', pct: '5.0000', unitPrice: '408.500000', reasonCode: 'LOYALTY' },
          { kind: 'MANUAL', delta: '21.500000', unitPrice: '430.000000', reasonCode: 'GOODWILL', note: 'Made-up test.' },
        ]),
      ),
    ).toBe(1)
  })

  it('is dropped when a writer changes the price without it, and kept when the price and its steps change together', async () => {
    const line = await draftLine({ listUnitPrice: '450.000000', unitPrice: '430.000000', priceSteps: steps('430.000000') })
    // W1's line route changes the price and leaves the steps as they were: the waterfall no longer explains it.
    expect(await update(office(), 'QuoteLine', line, `"unitPrice" = 425`)).toBe(1)
    expect(await one(`SELECT "priceSteps" IS NULL AS dropped, "unitPrice"::text AS price FROM "QuoteLine" WHERE id = $1`, [line])).toEqual({ dropped: true, price: '425.000000' })
    expect(await update(office(), 'QuoteLine', line, `"unitPrice" = 430, "priceSteps" = $2::jsonb`, json(steps('430.000000')))).toBe(1)
    expect(await update(office(), 'QuoteLine', line, `"listUnitPrice" = 460`)).toBe(1)
    expect(await one(`SELECT "priceSteps" IS NULL AS dropped FROM "QuoteLine" WHERE id = $1`, [line])).toEqual({ dropped: true })
    // A change of anything else keeps it.
    expect(await update(office(), 'QuoteLine', line, `"listUnitPrice" = 450, "priceSteps" = $2::jsonb`, json(steps('430.000000')))).toBe(1)
    expect(await update(office(), 'QuoteLine', line, `note = 'A note'`)).toBe(1)
    expect(await one(`SELECT "priceSteps" IS NOT NULL AS kept FROM "QuoteLine" WHERE id = $1`, [line])).toEqual({ kept: true })
    // The order line: the same rules (an amendment changes the price without them).
    await expect(update(office(), 'SalesOrderLine', s.order.lineId, `"priceSteps" = jsonb_set("priceSteps", '{3,unitPrice}', '"471.000000"')`)).rejects.toThrow(/NET says 471.000000 but the steps reach 470.000000/)
    expect(await update(office(), 'SalesOrderLine', s.order.lineId, `"unitPrice" = 469`)).toBe(1)
    expect(await one(`SELECT "priceSteps" IS NULL AS dropped FROM "SalesOrderLine" WHERE id = $1`, [s.order.lineId])).toEqual({ dropped: true })
  })
})

describe('fee lines, delivery schedules and chosen options', () => {
  it('gives a FEE line its fee kind, and no schedule and no options', async () => {
    await expect(draftLine({ kind: 'FEE', quantity: 1 })).rejects.toThrow(/fee kind exactly when it is a FEE line/)
    await expect(draftLine({ feeKind: 'SAMPLE' })).rejects.toThrow(/fee kind exactly when it is a FEE line/)
    await expect(delivery(s.draftQuote.feeLineId, '2026-12-10', null, 1)).rejects.toThrow(/is a fee: it has no delivery schedule/)
    await expect(option(s.draftQuote.feeLineId)).rejects.toThrow(/is a fee: it takes no options/)
    const line = await draftLine()
    expect(await delivery(line, '2026-12-10', { '50': 1 }, 1)).toBe(1)
    await expect(update(office(), 'QuoteLine', line, `kind = 'FEE', "feeKind" = 'SAMPLE'`)).rejects.toThrow(/has a delivery schedule or options: a FEE line has neither/)
  })

  it('schedules the sizes the line has, never more of a size than it has, the quantity their sum', async () => {
    const line = await draftLine()
    await expect(delivery(line, '2026-12-01', { '48': 1 }, 1)).rejects.toThrow(/brings size 48, which line .* does not have/)
    await expect(delivery(line, '2026-12-01', { '50': 1, '52': 1 }, 3)).rejects.toThrow(/brings 2 pieces, the sum of its sizes, not 3/)
    await expect(delivery(line, '2026-12-01', null, 1)).rejects.toThrow(/the pieces per size are an object of size codes/)
    await expect(delivery(line, '2026-12-01', {}, 0)).rejects.toThrow(/name 1 to 100 sizes/)
    expect(await delivery(line, '2026-12-01', { '50': 1, '52': 3 }, 4)).toBe(1)
    await expect(delivery(line, '2026-12-08', { '52': 2 }, 2)).rejects.toThrow(/bring 5 pieces of size 52, but the line has 4/)
    expect(await delivery(line, '2026-12-08', { '52': 1, '54': 2 }, 3)).toBe(1)
    await expect(delivery(line, '2026-12-08', { '54': 1 }, 1)).rejects.toThrow(/duplicate key|unique/i)
    // Removed with its line (a draft's line is deleted with its parts; W1 removes the size rows first).
    expect(await run(office(), `DELETE FROM "QuoteLineSize" WHERE "lineId" = $1::uuid`, line)).toBe(3)
    expect(await remove(office(), 'QuoteLine', line)).toBe(1)
    expect(await one(`SELECT count(*)::int AS n FROM "QuoteLineDelivery" WHERE "lineId" = $1`, [line])).toEqual({ n: 0 })
  })

  it('writes the parts of a quote line only while the version is DRAFT, and of an order line while the order is open', async () => {
    // SEED-Q-0004 was sent (and, by the reminder's test, expired).
    await expect(delivery(s.sentQuote.lineId, '2026-12-10', { '52': 1 }, 1)).rejects.toThrow(/is (SENT|EXPIRED); its delivery schedule changes only while it is DRAFT/)
    await expect(option(s.sentQuote.lineId)).rejects.toThrow(/is (SENT|EXPIRED); the options of its lines change only while it is DRAFT/)
    // A made-to-measure line's one delivery brings its one unit.
    const mtm = (await one(`SELECT id::text AS id FROM "QuoteLine" WHERE "tenantId" = $1 AND kind = 'MADE_TO_MEASURE' ORDER BY id LIMIT 1`, [a.tenantId])).id as string
    await expect(delivery(mtm, '2026-12-10', { '52': 1 }, 1)).rejects.toThrow(/brings its one unit \(no sizes\)/)
    expect(await delivery(mtm, '2026-12-10', null, 1)).toBe(1)
    await expect(delivery(mtm, '2026-12-11', null, 1)).rejects.toThrow(/has one delivery: its one unit/)
    // An order cancelled: its lines' schedule and options are fixed.
    const order = randomUUID()
    const orderLine = randomUUID()
    expect(await copyRow(office(), 'SalesOrder', s.order.orderId, { id: order, number: `T-SO-${order.slice(0, 8)}` })).toBe(1)
    expect(await copyRow(office(), 'SalesOrderLine', s.order.lineId, { id: orderLine, orderId: order })).toBe(1)
    expect(await run(office(), `INSERT INTO "SalesOrderLineSize" (id, "lineId", "partyId", size, quantity) VALUES ($1::uuid, $2::uuid, $3::uuid, '52', 2)`, randomUUID(), orderLine, A.P1)).toBe(1)
    expect(await delivery(orderLine, '2027-02-01', { '52': 2 }, 2, 'SalesOrderLineDelivery')).toBe(1)
    expect(await update(office(), 'SalesOrder', order, `status = 'CANCELLED', "cancelReason" = 'Made-up test.', "closedAt" = now()`)).toBe(1)
    await expect(delivery(orderLine, '2027-02-05', { '52': 1 }, 1, 'SalesOrderLineDelivery')).rejects.toThrow(/is CANCELLED; its delivery schedule changes only while it is CONFIRMED, IN_PRODUCTION or READY/)
    await expect(option(orderLine, {}, 'SalesOrderLineOption', firstKey('sales-pricing:SO4:option:ARMOUR'))).rejects.toThrow(/is CANCELLED; the options of its lines change only while/)
  })

  it('chooses a value of a group the style offers, the customer\'s text by the value\'s rule, a surcharge never 0', async () => {
    const line = await draftLine()
    const nameOption = key('sales-pricing:Q3:option:NAME')
    const fromName = (changes: Record<string, unknown>) => option(line, changes, 'QuoteLineOption', nameOption)
    await expect(fromName({ freeText: null })).rejects.toThrow(/customer's text exactly when its value takes one/)
    await expect(fromName({ freeText: 'ROSSI-MARIANI-X' })).rejects.toThrow(/one line of at most 12 characters matching the value's pattern/)
    await expect(fromName({ freeText: 'R2D2' })).rejects.toThrow(/matching the value's pattern/)
    expect(await fromName({ freeText: "D'Angelo" })).toBe(1)
    await expect(option(line, { freeText: 'Not for this value' })).rejects.toThrow(/customer's text exactly when its value takes one/)
    await expect(option(line, { surchargeAmount: '0' })).rejects.toThrow(/surcharge never 0/)
    await expect(option(line, { surchargePct: '5.0000' })).rejects.toThrow(/percent .* only with the amount it gave/)
    await expect(option(line, { itemColourId: randomUUID() })).rejects.toThrow(/material's colour only with the material/)
    // A group the line's style does not offer: SEED-Q-0004's SEED-JKT-01 never offered the armour group.
    const jkt01Line = await draftLine({ styleId: (await one(`SELECT "styleId"::text AS id FROM "QuoteLine" WHERE id = $1`, [s.sentQuote.lineId])).id, colourwayId: (await one(`SELECT "colourwayId"::text AS id FROM "QuoteLine" WHERE id = $1`, [s.sentQuote.lineId])).id, styleRevisionId: null, priceSteps: null })
    await expect(option(jkt01Line)).rejects.toThrow(/of a group the style of line .* does not offer/)
    // The pick keeps its line and value: another choice is another row.
    const id = randomUUID()
    expect(await copyRow(office(), 'QuoteLineOption', firstKey('sales-pricing:Q3:option:ARMOUR'), { id, lineId: line })).toBe(1)
    await expect(update(office(), 'QuoteLineOption', id, `"valueId" = $2::uuid`, (await one(`SELECT "valueId"::text AS id FROM "QuoteLineOption" WHERE id = $1`, [key('sales-pricing:Q3:option:LINER')])).id)).rejects.toThrow(/foreign key|keeps its line, group and value/i)
    expect(await update(office(), 'QuoteLineOption', id, `"surchargeAmount" = -25`)).toBe(1)
  })
})

describe('price lists: breaks, size surcharges, dated prices', () => {
  const draftEntry = () => firstKey('pricing:list:P1:v2:JKT-01')

  it('writes breaks only while the version is a DRAFT: a unit price or a discount, a version-wide one a discount, from 2 pieces', async () => {
    const [first] = s.breakIds
    const copy = (changes: Record<string, unknown>) => copyRow(office(), 'PriceBreak', first!, { id: randomUUID(), minQuantity: (seq += 1), ...changes })
    await expect(copy({ discountPct: '5.0000' })).rejects.toThrow(/unit price above 0 or a discount above 0 and below 100 percent, exactly one/)
    await expect(copy({ unitPrice: null, discountPct: '100' })).rejects.toThrow(/exactly one/)
    await expect(copy({ minQuantity: 1 })).rejects.toThrow(/from 2 pieces or more/)
    await expect(copy({ entryId: null })).rejects.toThrow(/for every entry of its version: it gives a discount, not one unit price/)
    expect(await copy({ entryId: null, unitPrice: null, discountPct: '2.5000' })).toBe(1)
    await expect(copy({ entryId: null, unitPrice: null, discountPct: '2.0000', minQuantity: 100 })).rejects.toThrow(/PriceBreak_one_per_version_quantity|duplicate key/)
    await expect(update(office(), 'PriceBreak', first!, `"entryId" = NULL, "unitPrice" = NULL, "discountPct" = 1`)).rejects.toThrow(/keeps its version and entry/)
    // An ACTIVE version's breaks are fixed: its version 1 takes none.
    const active = (await one(`SELECT v.id::text AS id FROM "PriceListVersion" v JOIN "PriceList" l ON l.id = v."listId" WHERE l."tenantId" = $1 AND l.code = 'SEED-PL-P1' AND v.status = 'ACTIVE'`, [a.tenantId])).id as string
    await expect(copy({ versionId: active, entryId: null, unitPrice: null, discountPct: '1.0000' })).rejects.toThrow(/is ACTIVE; its quantity breaks are fixed/)
    // Removed with their entry (a DRAFT's prices are deleted with their parts).
    const entry = randomUUID()
    expect(await copyRow(office(), 'PriceListEntry', draftEntry(), { id: entry })).toBe(1)
    expect(await copy({ entryId: entry })).toBe(1)
    expect(await remove(office(), 'PriceListEntry', entry)).toBe(1)
    expect(await one(`SELECT count(*)::int AS n FROM "PriceBreak" WHERE "entryId" = $1`, [entry])).toEqual({ n: 0 })
  })

  it('gives a size surcharge a scope, an amount in the list\'s currency or a percent, one per scope and size', async () => {
    const copy = (from: string, changes: Record<string, unknown>) => copyRow(office(), 'SizeSurcharge', from, { id: randomUUID(), size: `S${(seq += 1)}`, ...changes })
    await expect(copy(s.surchargeIds.size56, { versionId: null, styleId: null })).rejects.toThrow(/of a price list version, a style, or both/)
    await expect(copy(s.surchargeIds.size56, { currency: 'USD' })).rejects.toThrow(/is in USD, its price list in EUR/)
    await expect(copy(s.surchargeIds.size56, { surchargePct: '5.0000' })).rejects.toThrow(/exactly one/)
    await expect(copy(s.surchargeIds.size56, { size: '5 6' })).rejects.toThrow(/names a size code/)
    await expect(copy(s.surchargeIds.jkt05Size54, { surchargePct: '120' })).rejects.toThrow(/percent above 0 and at most 100/)
    await expect(copy(s.surchargeIds.jkt05Size54, { size: '54' })).rejects.toThrow(/SizeSurcharge_one_per_style_size|duplicate key/)
    await expect(copy(s.surchargeIds.size56, { size: '56' })).rejects.toThrow(/SizeSurcharge_one_per_version_size|duplicate key/)
    expect(await update(office(), 'SizeSurcharge', s.surchargeIds.jkt05Size54, `"surchargePct" = 6`)).toBe(1)
    await expect(update(office(), 'SizeSurcharge', s.surchargeIds.jkt05Size54, `size = '56'`)).rejects.toThrow(/keeps its version, style and size/)
  })

  it('dates an entry inside its version: it ends on or after it starts', async () => {
    await expect(update(office(), 'PriceListEntry', draftEntry(), `"validFrom" = '2027-03-01', "validTo" = '2027-02-01'`)).rejects.toThrow(/ends \(2027-02-01\) before it starts \(2027-03-01\)/)
    expect(await update(office(), 'PriceListEntry', draftEntry(), `"validFrom" = '2027-02-01', "validTo" = '2027-02-01'`)).toBe(1)
  })
})

describe('minimums, size curves, margin floors', () => {
  it('keeps a minimum about exactly one subject of its company, with a surcharge exactly when it is one', async () => {
    const [warn, surcharge] = s.moqRuleIds
    const copy = (from: string, changes: Record<string, unknown>) => copyRow(office(), 'MoqRule', from, { id: randomUUID(), ...changes })
    await expect(copy(warn, { productType: 'JACKET' })).rejects.toThrow(/one style, one kind of garment or one material: exactly one/)
    await expect(copy(warn, { minQuantity: 1 })).rejects.toThrow(/2 pieces or more/)
    await expect(copy(warn, { surchargePct: '5.0000' })).rejects.toThrow(/exactly when it is a SURCHARGE/)
    await expect(copy(surcharge, { surchargeAmount: null, currency: null })).rejects.toThrow(/exactly when it is a SURCHARGE/)
    await expect(copy(surcharge, { surchargePct: '5.0000' })).rejects.toThrow(/exactly when it is a SURCHARGE/)
    expect(await copy(surcharge, { surchargeAmount: null, currency: null, surchargePct: '7.5000' })).toBe(1)
    await expect(copy(surcharge, { companyId: A.companyB })).rejects.toThrow(/binds a price list of another company/)
    await expect(update(office(), 'MoqRule', warn, `"productType" = 'JACKET', "styleId" = NULL`)).rejects.toThrow(/keeps its company and what it is about/)
    expect(await update(office(), 'MoqRule', warn, `status = 'ARCHIVED'`)).toBe(1)
  })

  it('totals a size curve exactly 100 over sizes of its scale', async () => {
    const [curve] = s.curveIds
    const shares = (value: unknown) => update(office(), 'SizeCurve', curve, `shares = $2::jsonb`, json(value))
    await expect(shares({ '50': '50.0000', '52': '49.9999' })).rejects.toThrow(/total 99.9999, not 100/)
    await expect(shares({ '50': '50', '58': '50' })).rejects.toThrow(/names "58", not a size of its scale/)
    await expect(shares({ '50': 50, '52': '50' })).rejects.toThrow(/a percent above 0 and at most 100, up to 4 decimals, as a string/)
    await expect(shares({ '50': '0', '52': '100' })).rejects.toThrow(/a percent above 0/)
    await expect(shares({})).rejects.toThrow(/not 100/)
    expect(await shares({ '50': '33.3333', '52': '33.3334', '54': '33.3333' })).toBe(1)
    await expect(update(office(), 'SizeCurve', curve, `"companyId" = NULL`)).rejects.toThrow(/keeps its company and scale/)
    await expect(copyRow(office(), 'SizeCurve', curve, { id: randomUUID() })).rejects.toThrow(/duplicate key|unique/i)
  })

  it('gives margin floors to office roles of the tenant only, each 0 to 100 percent', async () => {
    const floors = (value: unknown) => update(office(), 'SalesSettings', a.tenantId, `"marginFloorByRole" = $2::jsonb`, json(value))
    await expect(floors({ ghost: '10.0000' })).rejects.toThrow(/give a margin floor to "ghost", not an office role of the tenant/)
    await expect(floors({ operator: '10.0000' })).rejects.toThrow(/not an office role of the tenant/)
    await expect(floors({ sales: '101' })).rejects.toThrow(/is a percent 0 to 100, up to 4 decimals, as a string/)
    await expect(floors({ sales: 25 })).rejects.toThrow(/as a string/)
    await expect(floors(['sales'])).rejects.toThrow(/\{ role key: percent \}/)
    expect(await floors({ sales: '22.5000', finance: '0' })).toBe(1)
    expect(await update(office(), 'SalesSettings', a.tenantId, `"marginFloorByRole" = NULL`)).toBe(1)
  })
})

describe('a work order cell\'s option values', () => {
  it('names option values its order line chose, each once, and never makes a fee', async () => {
    const cell = (await one(`SELECT s.id::text AS id, s."salesOrderLineId"::text AS line FROM "WorkOrderSize" s JOIN "WorkOrder" w ON w.id = s."workOrderId" WHERE w."tenantId" = $1 AND w.status = 'DRAFT' ORDER BY s.id LIMIT 1`, [a.tenantId])) as { id: string; line: string }
    const values = (ids: string[]) => update(office(), 'WorkOrderSize', cell.id, `"optionValueIds" = $2::uuid[]`, ids)
    const nameValue = (await one(`SELECT "valueId"::text AS id FROM "QuoteLineOption" WHERE id = $1`, [key('sales-pricing:Q3:option:NAME')])).id as string
    await expect(values([randomUUID()])).rejects.toThrow(/not an option value/)
    await expect(values([nameValue])).rejects.toThrow(/which its order line .* did not choose/)
    // The order line chooses the name, a group its style offered once (an archived offer, as SEED-JKT-01's).
    const archivedOffer = (await one(`SELECT id::text AS id FROM "StyleOptionGroup" WHERE "tenantId" = $1 AND status = 'ARCHIVED' ORDER BY id LIMIT 1`, [a.tenantId])).id as string
    const lineStyle = (await one(`SELECT "styleId"::text AS id FROM "SalesOrderLine" WHERE id = $1`, [cell.line])).id as string
    if (!(await one(`SELECT count(*)::int AS n FROM "StyleOptionGroup" WHERE "styleId" = $1 AND "groupId" = (SELECT "groupId" FROM "StyleOptionGroup" WHERE id = $2)`, [lineStyle, archivedOffer])).n) {
      expect(await copyRow(office(), 'StyleOptionGroup', archivedOffer, { id: randomUUID(), styleId: lineStyle })).toBe(1)
    }
    expect(await option(cell.line, { groupId: (await one(`SELECT "groupId"::text AS id FROM "QuoteLineOption" WHERE id = $1`, [key('sales-pricing:Q3:option:NAME')])).id, valueId: nameValue, freeText: 'ROSSI', byDefault: false }, 'SalesOrderLineOption', firstKey('sales-pricing:SO4:option:ARMOUR'))).toBe(1)
    await expect(values([nameValue, nameValue])).rejects.toThrow(/each option value once/)
    expect(await values([nameValue])).toBe(1)
    // A fee line is never made: a cell naming one is refused (W1's kind rule speaks first on a size-grid work order).
    const fee = randomUUID()
    expect(await copyRow(office(), 'SalesOrderLine', cell.line, { id: fee, seq: 990, kind: 'FEE', feeKind: 'DEVELOPMENT', quantity: 1, priceSteps: null })).toBe(1)
    await expect(copyRow(office(), 'WorkOrderSize', cell.id, { id: randomUUID(), size: 'FEE', salesOrderLineId: fee, optionValueIds: [] })).rejects.toThrow(/a fee is never made|the same style, colourway, kind/)
  })
})

describe('what a partner session reads', () => {
  it('reads its own schedules and chosen options, never a line\'s waterfall', async () => {
    const own = await sql(partner(), `SELECT count(*)::int AS n FROM "QuoteLineDelivery"`)
    expect(Number(own[0]!.n)).toBeGreaterThan(0)
    expect(Number((await sql(partner(), `SELECT count(*)::int AS n FROM "SalesOrderLineOption"`))[0]!.n)).toBeGreaterThan(0)
    await expect(sql(partner(), `SELECT "priceSteps" FROM "QuoteLine" LIMIT 1`)).rejects.toThrow(/permission denied/)
    await expect(sql(partner(), `SELECT "priceSteps" FROM "SalesOrderLine" LIMIT 1`)).rejects.toThrow(/permission denied/)
    await expect(sql(partner(), `SELECT "templateId" FROM "Quote" LIMIT 1`)).rejects.toThrow(/permission denied/)
    await expect(sql(partner(), `SELECT 1 FROM "QuoteTemplate" LIMIT 1`)).rejects.toThrow(/permission denied/)
    await expect(sql(partner(), `SELECT 1 FROM "PriceBreak" LIMIT 1`)).rejects.toThrow(/permission denied/)
  })
})
