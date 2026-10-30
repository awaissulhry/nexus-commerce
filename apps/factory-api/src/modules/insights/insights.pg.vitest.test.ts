import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { grainPermission } from '@nexus/factory-domain/auth/grains/grains'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
import { addDays } from '@nexus/factory-domain/invoicing/from-shipment/deadlines'
import { resendDeadline } from '@nexus/factory-domain/invoicing/sdi/deadline'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../packages/factory-db/seed/_core'
import { seed as seedCompliance } from '../../../../../packages/factory-db/seed/compliance'
import { seed as seedEmailIn } from '../../../../../packages/factory-db/seed/email-in'
import { seed as seedMoney } from '../../../../../packages/factory-db/seed/money'
import { seed as seedPrivacy } from '../../../../../packages/factory-db/seed/privacy'
import { seedUuid } from '../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../core/app'
import { testAuthenticator, type SessionContext } from '../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../env'
import { startHarness, type Harness } from '../../platform/auth/sessions/testing/harness'

/**
 * Home › Today (B-W1-52; ANA-037; A2 SCR-029, SCR-031 W1) on the local stack: a throwaway PostgreSQL 17 database from the
 * migrations (the runtime login: row-level security and every module's triggers are real) and the real app with test
 * sessions made from the role templates (their permissions and grains). One made-up tenant from the factory-db seeds up
 * to money (orders, work orders, lots, purchase orders, scans, shipments, invoices, the PPE register, privacy), moved by
 * the moves each module's triggers allow into what needs a person: SEED-SO-0001 two days late, SEED-SO-0003 due in two
 * days, WO-0002 due tomorrow with no batch series (its release check holds it), a lot in quarantine received by the
 * second inspector and a blocked lot, an invoice SDI rejected yesterday, SEED-Q-0002 waiting for an approval of its
 * margin that the sales person asked, SEED-PO-0002 sent by the buyer three days ago and not confirmed. The seeds bring
 * the rest: an open scan correction and a refused scan, SH-0001's DDT not invoiced, an open PPE register complaint,
 * company B without its privacy paperwork, released styles without their Declaration of Conformity. Every name, number
 * and amount is made up. Run with `node scripts/factory/run-pg-tests.mjs insights`.
 */

let h: Harness
let app: FastifyInstance

const NS = 'insights-a'
const idOf = (key: string) => seedUuid(NS, key)
const T = idOf('tenant')
const companyA = idOf('company:A')
const companyB = idOf('company:B')
const siteA = idOf('site:A1')
const P1 = idOf('party:P1')
const TODAY = businessDate(new Date())

type Json = Record<string, any>
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]
const one = async <R = Json>(sql: string, values: unknown[] = []): Promise<R> => (await admin<R>(sql, values))[0]!

// ---- sessions from the role templates ------------------------------------------------------------------------------------

const PEOPLE = {
  owner: newId(),
  ownerA: newId(),
  buyer: newId(),
  inspector: newId(),
  inspector2: newId(),
  sales: newId(),
  finance: newId(),
  nobody: newId(),
} as const

function fromTemplate(key: string, companies: Grant['companies'] = 'all'): Grant {
  const template = templateOf(key)!
  return { permissions: [...template.permissions, ...template.grains.map((grain) => grainPermission(grain) as Permission)], companies, sites: 'all', parties: 'all' }
}
const office = (actorId: string, grants: Grant[]): (() => SessionContext) => () => ({ audience: 'office', tenantId: T, actorId, grants })
const SESSIONS: Record<string, () => SessionContext> = {
  owner: office(PEOPLE.owner, [fromTemplate('owner')]),
  ownerA: office(PEOPLE.ownerA, [fromTemplate('owner', [companyA])]),
  ownerB: office(newId(), [fromTemplate('owner', [companyB])]),
  buyer: office(PEOPLE.buyer, [fromTemplate('buyer')]),
  /** The buyer with the buyer's permissions but without the cost grain (a custom role): the same rows, never a purchase price. */
  buyerNoCost: office(PEOPLE.buyer, [{ ...fromTemplate('buyer'), permissions: templateOf('buyer')!.permissions }]),
  inspector: office(PEOPLE.inspector, [fromTemplate('quality_inspector')]),
  inspector2: office(PEOPLE.inspector2, [fromTemplate('quality_inspector')]),
  sales: office(PEOPLE.sales, [fromTemplate('sales')]),
  finance: office(PEOPLE.finance, [fromTemplate('finance')]),
  nobody: office(PEOPLE.nobody, [{ permissions: ['home.view'], companies: 'all', sites: 'all', parties: 'all' }]),
  noHome: office(newId(), [{ permissions: ['orders.view', 'orders.manage'], companies: 'all', sites: 'all', parties: 'all' }]),
  floor: () => ({ audience: 'floor', tenantId: T, actorId: newId(), siteId: siteA, deviceId: newId(), grants: [{ permissions: ['floor.work', 'home.view'], companies: [companyA], sites: [siteA], parties: 'all' }] }),
}

async function get(session: string, url: string): Promise<{ status: number; body: Json }> {
  const response = await app.inject({ method: 'GET', url, headers: { 'x-test-session': session } })
  return { status: response.statusCode, body: response.json() as Json }
}
async function ok(session: string, url: string): Promise<Json> {
  const answer = await get(session, url)
  expect(answer.status, JSON.stringify(answer.body)).toBe(200)
  return answer.body
}
const today = (session: string, query = '') => ok(session, `/home/today?limit=200${query}`)
const kindsOf = (answer: Json): string[] => [...new Set((answer.items as Json[]).map((item) => item.kind))].sort()
const itemOf = (answer: Json, recordId: string): Json | undefined => (answer.items as Json[]).find((item) => item.record.id === recordId)

// ---- the states ------------------------------------------------------------------------------------------------------------

const ids = {} as { lateOrder: string; riskOrder: string; heldWorkOrder: string; quarantineLot: string; blockedLot: string; rejectedInvoice: string; quote: string; po: string }
let rejectedAt: Date

/** An invoice of company A for P1, issued, sent and rejected by SDI (NS) yesterday, written as the money seed writes. */
async function rejectedInvoice(): Promise<string> {
  const invoiceId = newId()
  const series = await one<{ id: string; nextValue: number }>(`SELECT id, "nextValue" FROM "NumberSeries" WHERE "tenantId" = $1 AND "companyId" = $2 AND kind = 'INVOICE' AND "scopeKey" = '2026'`, [T, companyA])
  const number = `FT-2026-${String(series.nextValue).padStart(5, '0')}`
  const issueDay = new Date('2026-11-12T00:00:00.000Z')
  const xmlId = newId()
  const fileName = `ITINSIGHTS_${series.nextValue}.xml`
  const submissionId = newId()
  rejectedAt = new Date(Date.now() - 24 * 3_600_000)
  const actorId = newId()
  await h.database.withScope({ audience: 'office', tenantId: T, actorId }, (client) =>
    client.$transaction(async (tx) => {
      const select = { id: true } as const
      await tx.invoice.create({
        data: {
          id: invoiceId,
          companyId: companyA,
          buyerPartyId: P1,
          docType: 'TD01',
          priceBasis: 'NET',
          billTo: { kind: 'IT_BUSINESS', vatNumber: '00000001016', fiscalCode: '00000001016', name: 'Seed Customer One S.r.l.', address: { street: 'Via Esempio', streetNumber: '10', postcode: '00000', city: 'Seedville', province: 'MI', country: 'IT' }, sdiCode: 'SEEDC01' },
          netTotal: 10000,
          vatTotal: 2200,
          grossTotal: 12200,
          vatSummary: [{ rate: '22.00', nature: null, legalRef: null, taxable: 10000, vat: 2200, rounding: 0 }],
          paymentTerms: { condition: 'TP02', installments: [{ method: 'MP05', amount: 12200, dueDate: '2026-12-12' }] },
          causale: 'Made-up test invoice',
          createdById: actorId,
        },
        select,
      })
      await tx.invoiceLine.create({ data: { id: newId(), invoiceId, buyerPartyId: P1, seq: 1, kind: 'GOODS', description: 'Made-up jacket', quantity: '1.0000', uom: 'PZ', unitPrice: '100.000000', netAmount: 10000, vatRatePct: '22.00', createdById: actorId }, select })
      await tx.storedFile.create({
        data: {
          id: xmlId,
          companyId: companyA,
          recordType: 'Invoice',
          recordId: invoiceId,
          kind: 'FISCAL_ARCHIVE',
          originalName: fileName,
          contentType: 'application/xml',
          sizeBytes: 2048,
          sha256: createHash('sha256').update(`insights ${invoiceId}`).digest('hex'),
          storeAccountId: idOf('files:account:r2'),
          storageKey: `legal/t/${T}/c/${companyA}/2026/${newId()}`,
          status: 'AVAILABLE',
          availableAt: new Date(),
          visibility: ['OFFICE'],
          retainUntil: new Date('2036-12-31T00:00:00.000Z'),
          createdById: actorId,
        },
        select,
      })
      await tx.numberAllocation.create({ data: { id: newId(), companyId: companyA, seriesId: series.id, kind: 'INVOICE', value: series.nextValue, formatted: number, documentDate: issueDay, recordType: 'Invoice', recordId: invoiceId, allocatedAt: new Date(), allocatedById: actorId, requestId: `insights-${invoiceId}` }, select })
      await tx.numberSeries.update({ where: { id: series.id }, data: { nextValue: series.nextValue + 1, lastIssuedDate: issueDay }, select })
      const seller = { vatNumber: '00000003038', name: 'Seed Company A', taxRegime: 'RF01', address: { street: 'Via Esempio', streetNumber: '1', postcode: '00000', city: 'Seedville', province: 'MI', country: 'IT' } }
      await tx.invoice.update({ where: { id: invoiceId }, data: { status: 'ISSUED', numberSeriesId: series.id, number, year: 2026, issueDate: issueDay, issuedAt: new Date(), issuedById: actorId, partyId: P1, seller, xmlFileId: xmlId, version: 2 }, select })
      await tx.sdiSubmission.create({
        data: { id: submissionId, partyId: P1, invoiceId, attempt: 1, integrationAccountId: idOf('integration:account:sdi'), fileName, xmlFileId: xmlId, status: 'SENT', providerRef: `fake-${submissionId}`, sentAt: rejectedAt, createdById: actorId },
        select,
      })
      await tx.invoice.update({ where: { id: invoiceId }, data: { status: 'SENT', version: 3 }, select })
      await tx.sdiNotification.create({
        data: { id: newId(), partyId: P1, invoiceId, submissionId, type: 'NS', sdiMessageId: `ns-${submissionId}`, receivedAt: rejectedAt, payload: { IdentificativoSdI: '999', NomeFile: fileName, MessageId: `ns-${submissionId}`, ListaErrori: [{ Codice: '00305', Descrizione: 'made up' }] }, createdById: actorId },
        select,
      })
      await tx.sdiSubmission.update({ where: { id: submissionId }, data: { status: 'REJECTED', sdiIdentifier: '999', outcomeAt: rejectedAt, failureReason: 'NS 00305', version: 2 }, select })
      await tx.invoice.update({ where: { id: invoiceId }, data: { status: 'REJECTED', version: 4 }, select })
    }),
  )
  return invoiceId
}

beforeAll(async () => {
  h = await startHarness('insights')
  h.clock.set(new Date())
  await seedCore({ db: h.database, namespace: NS })
  await seedCompliance({ db: h.database, namespace: NS })
  await seedPrivacy({ db: h.database, namespace: NS })
  await seedMoney({ db: h.database, namespace: NS })
  await seedEmailIn({ db: h.database, namespace: NS })

  const idByNumber = async (table: string, column: string, value: string) => (await one<{ id: string }>(`SELECT id FROM "${table}" WHERE "tenantId" = $1 AND "${column}" = $2`, [T, value])).id
  ids.lateOrder = await idByNumber('SalesOrder', 'number', 'SEED-SO-0001')
  ids.riskOrder = await idByNumber('SalesOrder', 'number', 'SEED-SO-0003')
  await admin(`UPDATE "SalesOrder" SET "promiseDate" = $2::date WHERE id = $1`, [ids.lateOrder, addDays(TODAY, -2)])
  await admin(`UPDATE "SalesOrder" SET "promiseDate" = $2::date, status = 'CONFIRMED' WHERE id = $1 AND status = 'CONFIRMED'`, [ids.riskOrder, addDays(TODAY, 2)])

  // WO-0002 (a draft) due tomorrow, and company A without a batch series: its release check holds it.
  ids.heldWorkOrder = (await one<{ id: string }>(`SELECT id FROM "WorkOrder" WHERE "tenantId" = $1 AND status = 'DRAFT' ORDER BY number LIMIT 1`, [T])).id
  await admin(`UPDATE "WorkOrder" SET "dueDate" = $2::date WHERE id = $1`, [ids.heldWorkOrder, addDays(TODAY, 1)])
  await admin(`UPDATE "NumberSeries" SET status = 'CLOSED' WHERE "tenantId" = $1 AND "companyId" = $2 AND kind = 'BATCH'`, [T, companyA])

  // Two lots of the lining at A1: one in quarantine (received by the second inspector), one blocked.
  const lining = await one<{ itemId: string }>(`SELECT "itemId" FROM "Lot" WHERE "tenantId" = $1 AND code = 'SEED-LOT-LIN-01'`, [T])
  ids.quarantineLot = newId()
  ids.blockedLot = newId()
  for (const [id, code] of [[ids.quarantineLot, 'INS-LOT-Q'], [ids.blockedLot, 'INS-LOT-B']] as const) {
    await admin(`INSERT INTO "Lot" (id, "tenantId", "companyId", "siteId", "itemId", code, "receivedAt", "createdById") VALUES ($1, $2, $3, $4, $5, $6, now() - interval '2 days', $7)`, [id, T, companyA, siteA, lining.itemId, code, PEOPLE.inspector2])
  }
  await admin(`UPDATE "Lot" SET "qualityStatus" = 'BLOCKED', "qualityDecidedAt" = now(), "qualityNote" = 'Made-up test block' WHERE id = $1`, [ids.blockedLot])

  ids.rejectedInvoice = await rejectedInvoice()

  // SEED-Q-0002 waits for an approval of its margin, asked by the sales person.
  ids.quote = await idByNumber('Quote', 'number', 'SEED-Q-0002')
  const version = await one<{ id: string; partyId: string }>(`SELECT id, "partyId" FROM "QuoteVersion" WHERE "quoteId" = $1 ORDER BY revision DESC LIMIT 1`, [ids.quote])
  await admin(`UPDATE "QuoteVersion" SET status = 'PENDING_APPROVAL', "netAmount" = 624000, "marginPct" = 14.25, "marginAmount" = 88920 WHERE id = $1`, [version.id])
  await admin(`UPDATE "Quote" SET status = 'PENDING_APPROVAL' WHERE id = $1`, [ids.quote])
  await admin(`INSERT INTO "QuoteApproval" (id, "tenantId", "versionId", "partyId", reasons, "createdById", "createdAt") VALUES ($1, $2, $3, $4, ARRAY['MARGIN_FLOOR']::"QuoteApprovalReason"[], $5, now() - interval '1 day')`, [newId(), T, version.id, version.partyId, PEOPLE.sales])

  // SEED-PO-0002 sent by the buyer three days ago, not confirmed.
  ids.po = await idByNumber('PurchaseOrder', 'number', 'SEED-PO-0002')
  await admin(
    `UPDATE "PurchaseOrder" SET status = 'SENT', "sentAt" = now() - interval '72 hours', "sentById" = $2,
       "netAmount" = (SELECT coalesce(sum(l."netAmount"), 0) FROM "PurchaseOrderLine" l WHERE l."purchaseOrderId" = $1) WHERE id = $1`,
    [ids.po, PEOPLE.buyer],
  )

  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])]?.() ?? null) },
  )
}, 300_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

describe('the owner: everything that waits, from every area and company, ranked', () => {
  it('each seeded state is one row of its kind, with why it is mine and what waits on it', async () => {
    const answer = await today('owner')
    expect(kindsOf(answer)).toEqual(
      expect.arrayContaining(['INVOICE_SDI', 'INVOICE_TO_ISSUE', 'LOT_HOLD', 'ORDER_PROMISE', 'PO_NOT_CONFIRMED', 'PRIVACY_DUTY', 'QUOTE_APPROVAL', 'REGISTER_DUTY', 'SCAN_CORRECTION', 'SCAN_REFUSAL', 'STYLE_COMPLIANCE', 'WORK_ORDER_HELD', 'MAIL_TO_SORT']),
    )
    expect(itemOf(answer, ids.lateOrder)).toMatchObject({
      kind: 'ORDER_PROMISE',
      state: 'LATE',
      severity: 'HIGH',
      group: 'NOW',
      record: { type: 'SalesOrder', label: 'SEED-SO-0001' },
      companyId: companyA,
      why: "You manage this customer's orders and their promise dates.",
      due: { date: addDays(TODAY, -2), days: -2, word: 'OVERDUE' },
      decide: 'OPEN',
    })
    expect(itemOf(answer, ids.lateOrder)!.sentence).toMatch(/^Order SEED-SO-0001 for .+ is 2 days late/)
    expect(itemOf(answer, ids.lateOrder)!.blocks).toMatch(/waits for \d+ pieces?\./)
    expect(itemOf(answer, ids.heldWorkOrder)).toMatchObject({ kind: 'WORK_ORDER_HELD', severity: 'HIGH', due: { days: 1, word: 'SOON' }, why: 'You release work orders at this site.' })
    expect(itemOf(answer, ids.heldWorkOrder)!.sentence).toContain('batch number series')
    expect(itemOf(answer, ids.quarantineLot)).toMatchObject({ kind: 'LOT_HOLD', state: 'QUARANTINE', severity: 'MEDIUM', siteId: siteA })
    expect(itemOf(answer, ids.blockedLot)).toMatchObject({ kind: 'LOT_HOLD', state: 'BLOCKED', severity: 'HIGH' })
    expect(itemOf(answer, ids.rejectedInvoice)).toMatchObject({ kind: 'INVOICE_SDI', state: 'REJECTED', severity: 'HIGH', due: { date: resendDeadline(rejectedAt) }, figures: { currency: 'EUR', netAmount: 10000 } })
    expect(itemOf(answer, ids.rejectedInvoice)!.sentence).toContain(`by ${resendDeadline(rejectedAt)}`)
    expect(itemOf(answer, ids.quote)).toMatchObject({ kind: 'QUOTE_APPROVAL', category: 'APPROVAL', decide: 'REVIEW', figures: { netAmount: 624000, marginPct: '14.25', marginAmount: 88920 } })
    expect(itemOf(answer, ids.quote)!.sentence).toBe('Quote SEED-Q-0002 for Seed Customer One S.r.l. waits for an approval: margin under the floor (margin 14.3 %).')
    expect(itemOf(answer, ids.po)).toMatchObject({ kind: 'PO_NOT_CONFIRMED', figures: { currency: 'EUR' } })
    expect(itemOf(answer, ids.po)!.sentence).toMatch(/not confirmed 3 days after it was sent \(EUR \d+\.\d{2}\)\.$/)
    expect(itemOf(answer, companyB)).toMatchObject({ kind: 'PRIVACY_DUTY', severity: 'HIGH', record: { type: 'Company' } })
    expect((answer.items as Json[]).find((item) => item.kind === 'STYLE_COMPLIANCE')!.blocks).toMatch(/^It holds up the .+ of open orders \(sales orders: \d+, work orders: \d+\)\.$/)
    expect(answer.live.events).toEqual(expect.arrayContaining(['sales_order.promise_changed', 'lot.released', 'invoice.sdi_status_changed', 'quote.approval_requested']))
  })

  it('the rank is stable (severity, due, age, key): the same twice, and pages walk it once, row by row', async () => {
    const first = await today('owner')
    const second = await today('owner')
    expect(second.items.map((item: Json) => item.key)).toEqual(first.items.map((item: Json) => item.key))
    const rank: Record<string, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 }
    const keyOf = (item: Json) => [rank[item.severity] ?? 9, item.due?.date ?? '9999-12-31', item.since, item.key] as const
    for (let index = 1; index < first.items.length; index += 1) {
      const [a, b] = [keyOf(first.items[index - 1]), keyOf(first.items[index])]
      expect(a[0] < b[0] || (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && (a[2] < b[2] || (a[2] === b[2] && a[3] < b[3])))))).toBe(true)
    }
    const walked: string[] = []
    let cursor: string | null = null
    do {
      const page: Json = await ok('owner', `/home/today?limit=4${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
      walked.push(...page.items.map((item: Json) => item.key))
      cursor = page.nextCursor
    } while (cursor !== null)
    expect(walked).toEqual(first.items.map((item: Json) => item.key))
    expect((await get('owner', '/home/today?cursor=nonsense')).status).toBe(400)
  })

  it('the design’s three tiles: all rows, approvals (the reviews), alerts; each pressed shows exactly its count', async () => {
    const answer = await today('owner')
    const tiles = answer.counts.tiles as Json[]
    expect(tiles.map((tile) => tile.tile)).toEqual(['ALL', 'APPROVAL', 'ALERT'])
    const [all, approvals, alerts] = tiles.map((tile) => tile.count) as [number, number, number]
    expect(all).toBe(answer.total)
    expect(all).toBe(answer.items.length)
    expect(approvals + alerts).toBe(all)
    expect(tiles.every((tile) => tile.complete === true)).toBe(true)
    // Approvals are the decisions a person reviews; everything else is an alert.
    for (const item of answer.items as Json[]) expect(item.category, item.kind).toBe(item.decide === 'REVIEW' ? 'APPROVAL' : 'ALERT')
    expect(answer.counts.now).toBe((answer.items as Json[]).filter((item) => item.group === 'NOW').length)
    for (const [category, count] of [['APPROVAL', approvals], ['ALERT', alerts]] as const) {
      const pressed = await ok('owner', `/home/today?limit=200&category=${category}`)
      expect(pressed.total, category).toBe(count)
      expect(pressed.items.every((item: Json) => item.category === category)).toBe(true)
      expect(pressed.counts.tiles).toEqual(tiles)
    }
    // A deep link by kind still works, and its count is the kind's.
    expect(answer.counts.byKind.map((entry: Json) => entry.kind)).toHaveLength(14)
    for (const entry of answer.counts.byKind as Json[]) {
      const pressed = await ok('owner', `/home/today?limit=200&kind=${entry.kind}`)
      expect(pressed.total, entry.kind).toBe(entry.count)
    }
    // W2a: TASK and MENTION are categories again (the person's own rows, B-W2a-20); a word that is none is refused.
    expect((await get('owner', '/home/today?category=NOPE')).status).toBe(400)
  })

  it('every row comes as phrases for the reader’s language: keys and params, the English the same words', async () => {
    const answer = await today('owner')
    for (const item of answer.items as Json[]) {
      expect(item.words.sentence.key, item.kind).toMatch(new RegExp(`^${item.kind}\\.`))
      expect(item.words.why.key, item.kind).toMatch(new RegExp(`^why\\.${item.kind}\\.`))
      expect(item.words.blocks === null, item.kind).toBe(item.blocks === null)
    }
    expect(itemOf(answer, ids.lateOrder)!.words).toMatchObject({
      sentence: { key: 'ORDER_PROMISE.LATE', params: { number: 'SEED-SO-0001', count: 2, promiseDate: addDays(TODAY, -2) } },
      why: { key: 'why.ORDER_PROMISE.orders_manage', params: {} },
      blocks: { key: 'ORDER_PROMISE.waitsPieces' },
    })
    expect(itemOf(answer, ids.heldWorkOrder)!.words.sentence.params.checks).toContain('BATCH_NUMBER')
    expect(itemOf(answer, ids.rejectedInvoice)!.words.sentence).toEqual({ key: 'INVOICE_SDI.REJECTED', params: expect.objectContaining({ deadlineDate: resendDeadline(rejectedAt) }) })
    // The quote's margin is beside the sentence only for a reader with the margin grain; never in the params.
    expect(itemOf(answer, ids.quote)).toMatchObject({ sentenceFigure: 'marginPct', words: { sentence: { key: 'QUOTE_APPROVAL.PENDING', params: { reasons: ['MARGIN_FLOOR'] } } } })
    expect(JSON.stringify((answer.items as Json[]).map((item) => item.words))).not.toMatch(/EUR|624000|14\.25/)
  })

  it('the company and site filters (the top bar’s switcher)', async () => {
    const onlyB = await today('owner', `&companyId=${companyB}`)
    expect((onlyB.items as Json[]).every((item) => item.companyId === companyB || item.companyId === null)).toBe(true)
    expect(itemOf(onlyB, companyB)).toBeDefined()
    expect(itemOf(onlyB, ids.lateOrder)).toBeUndefined()
    const atA1 = await today('owner', `&siteId=${siteA}`)
    expect((atA1.items as Json[]).every((item) => item.siteId === siteA || (item.siteId === null && (item.companyId === companyA || item.companyId === null)))).toBe(true)
    expect(itemOf(atA1, ids.quarantineLot)).toBeDefined()
    expect(itemOf(atA1, companyB)).toBeUndefined()
    expect((await get('owner', `/home/today?siteId=${newId()}`)).status).toBe(404)
  })
})

describe('each role gets what it acts on, and nothing it cannot', () => {
  it('the buyer: its unconfirmed purchase order with its value; no quote approval, no lot it cannot release', async () => {
    const answer = await today('buyer')
    expect(kindsOf(answer)).toEqual(['MAIL_TO_SORT', 'PO_NOT_CONFIRMED'])
    expect(answer.counts.byKind.map((entry: Json) => [entry.kind, entry.count])).toEqual([
      ['PO_PROPOSAL', 0],
      ['PO_NOT_CONFIRMED', 1],
      ['MAIL_TO_SORT', 3],
    ])
    expect(answer.counts.tiles.map((tile: Json) => [tile.tile, tile.count])).toEqual([
      ['ALL', 4],
      ['APPROVAL', 3],
      ['ALERT', 1],
    ])
    expect(itemOf(answer, ids.po)).toMatchObject({ why: 'You send purchase orders to this supplier.', figures: { currency: 'EUR' } })
    expect(itemOf(answer, ids.po)!.figures.purchaseAmount).toEqual(expect.any(Number))
    expect(itemOf(answer, ids.quote)).toBeUndefined()
    expect(itemOf(answer, ids.quarantineLot)).toBeUndefined()
    // Without the cost grain: the same row, its value neither in the row nor in its sentence.
    const noCost = await today('buyerNoCost')
    expect(itemOf(noCost, ids.po)).toMatchObject({ kind: 'PO_NOT_CONFIRMED', figures: null })
    expect(itemOf(noCost, ids.po)!.sentence).toBe(itemOf(answer, ids.po)!.sentence.replace(/ \(EUR \d+\.\d{2}\)\.$/, '.'))
    expect(itemOf(noCost, ids.po)!.sentence).not.toContain('EUR')
    const waiting = (await ok('buyerNoCost', '/home/waiting-on-others')).items as Json[]
    expect(waiting).toMatchObject([{ kind: 'PO_CONFIRMATION', record: { id: ids.po }, figures: null }])
    expect(waiting[0]!.sentence).not.toContain('EUR')
  })

  it('the quality inspector: the lots, the register and the styles; never a lot they received; no order, no money', async () => {
    const answer = await today('inspector')
    expect(kindsOf(answer)).toEqual(['LOT_HOLD', 'REGISTER_DUTY', 'STYLE_COMPLIANCE'])
    expect(itemOf(answer, ids.quarantineLot)).toMatchObject({ why: 'You release lots at this site.' })
    expect(itemOf(answer, ids.blockedLot)).toBeDefined()
    expect((answer.items as Json[]).every((item) => item.figures === null)).toBe(true)
    const receiver = await today('inspector2')
    expect(itemOf(receiver, ids.quarantineLot)).toBeUndefined()
    expect(itemOf(receiver, ids.blockedLot)).toBeDefined()
  })

  it('sales: its customers’ late and at-risk orders with their value, never a cost; no release, no invoice, no approval it asked', async () => {
    const answer = await today('sales')
    expect(kindsOf(answer)).toEqual(['MAIL_TO_SORT', 'ORDER_PROMISE'])
    expect(itemOf(answer, ids.lateOrder)).toMatchObject({ state: 'LATE', figures: { currency: 'EUR', netAmount: expect.any(Number) } })
    expect(itemOf(answer, ids.riskOrder)).toMatchObject({ state: 'AT_RISK', severity: 'MEDIUM', group: 'THIS_WEEK', due: { days: 2, word: 'SOON' } })
    const text = JSON.stringify(answer)
    expect(text).not.toContain('purchaseAmount')
    expect(text).not.toContain('marginAmount')
    expect(itemOf(answer, ids.quote)).toBeUndefined()
    expect(answer.counts.byKind.map((entry: Json) => entry.kind)).toEqual(['ORDER_PROMISE', 'MAIL_TO_SORT'])
  })

  it('mail to sort: the email-in list of whoever sorts the company’s mail (triage, held, unreadable), opened in its own review', async () => {
    const mails = await admin<{ id: string; status: string }>(`SELECT id, status::text AS status FROM "InboundEmail" WHERE "tenantId" = $1 AND status IN ('TRIAGE', 'HELD', 'FAILED') ORDER BY id`, [T])
    expect(mails.map((mail) => mail.status).sort()).toEqual(['FAILED', 'HELD', 'TRIAGE'])
    const answer = await today('sales')
    const rows = (answer.items as Json[]).filter((item) => item.kind === 'MAIL_TO_SORT')
    expect(rows.map((row) => row.record.id).sort()).toEqual(mails.map((mail) => mail.id).sort())
    for (const row of rows) {
      expect(row).toMatchObject({ category: 'APPROVAL', decide: 'REVIEW', record: { type: 'InboundEmail' }, why: "You sort this company's received mail.", figures: null, due: null })
      expect(row.severity).toBe(row.state === 'FAILED' ? 'LOW' : 'MEDIUM')
    }
    expect(rows.find((row) => row.state === 'TRIAGE')!.sentence).toMatch(/reached no record: sort it\.$/)
    expect(rows.find((row) => row.state === 'HELD')!.sentence).toMatch(/is held: its sender's address failed the DMARC check\.$/)
    expect(answer.live.events).toContain('email.inbound_sorted')
    // The inspector does not sort mail; the owner limited to company B does not sort company A's.
    expect(kindsOf(await today('inspector'))).not.toContain('MAIL_TO_SORT')
    expect((await today('ownerB')).items.filter((item: Json) => item.kind === 'MAIL_TO_SORT')).toEqual([])
  })

  it('finance approves the quote the sales person asked (another person, with the margin grain)', async () => {
    const answer = await today('finance')
    expect(itemOf(answer, ids.quote)).toMatchObject({ kind: 'QUOTE_APPROVAL', why: "You approve this customer's quotes, and someone else asked." })
    expect(itemOf(answer, ids.rejectedInvoice)).toMatchObject({ kind: 'INVOICE_SDI', why: "You issue and send this customer's invoices." })
    expect((answer.items as Json[]).some((item) => item.kind === 'INVOICE_TO_ISSUE')).toBe(true)
  })

  it('a company wall: an owner limited to company A never sees company B', async () => {
    const answer = await today('ownerA')
    expect(itemOf(answer, companyB)).toBeUndefined()
    expect((answer.items as Json[]).every((item) => item.companyId === companyA || item.companyId === null)).toBe(true)
    expect(itemOf(answer, ids.lateOrder)).toBeDefined()
    const flow = await ok('ownerA', '/home/flow')
    const everywhere = await ok('owner', '/home/flow')
    const count = (answer: Json, lens: string) => (answer.lenses as Json[]).find((entry) => entry.lens === lens)!.stages.reduce((sum: number, stage: Json) => sum + stage.count, 0)
    expect(count(flow, 'ORDERS')).toBeLessThanOrEqual(count(everywhere, 'ORDERS'))
  })

  it('a person with nothing to act on gets an empty list, zero tiles, no lens and no wait; other audiences and no home.view are refused', async () => {
    const answer = await today('nobody')
    expect(answer).toMatchObject({
      total: 0,
      items: [],
      nextCursor: null,
      counts: { total: 0, now: 0, byKind: [], tiles: [{ tile: 'ALL', count: 0, complete: true }, { tile: 'APPROVAL', count: 0, complete: true }, { tile: 'ALERT', count: 0, complete: true }] },
      live: { events: [] },
    })
    expect((await ok('nobody', '/home/flow')).lenses).toEqual([])
    expect((await ok('nobody', '/home/waiting-on-others')).items).toEqual([])
    expect((await get('noHome', '/home/today')).status).toBe(403)
    expect((await get('floor', '/home/today')).status).toBe(403)
  })
})

describe('the flow strip', () => {
  it('per lens the person sees, every stage with its count, late rows and the oldest age; the counts are the records', async () => {
    const owner = await ok('owner', '/home/flow')
    expect(owner.lenses.map((lens: Json) => lens.lens)).toEqual(['ORDERS', 'WORK_ORDERS', 'PURCHASE_ORDERS', 'INVOICES', 'LOTS'])
    const orders = (owner.lenses as Json[]).find((lens) => lens.lens === 'ORDERS')!
    const open = await one<{ n: number }>(`SELECT count(*)::int AS n FROM "SalesOrder" WHERE "tenantId" = $1 AND status IN ('CONFIRMED', 'IN_PRODUCTION', 'READY', 'PARTLY_SHIPPED', 'SHIPPED')`, [T])
    expect(orders.stages.reduce((sum: number, stage: Json) => sum + stage.count, 0)).toBe(open.n)
    expect(orders.stages.reduce((sum: number, stage: Json) => sum + (stage.late ?? 0), 0)).toBeGreaterThanOrEqual(1)
    const lots = (owner.lenses as Json[]).find((lens) => lens.lens === 'LOTS')!
    expect(lots.stages.find((stage: Json) => stage.key === 'QUARANTINE')).toMatchObject({ count: 1, late: null, oldestDays: 2, filter: null })
    expect(lots.stages.find((stage: Json) => stage.key === 'BLOCKED')).toMatchObject({ count: 1 })
    const pos = (owner.lenses as Json[]).find((lens) => lens.lens === 'PURCHASE_ORDERS')!
    expect(pos.stages.find((stage: Json) => stage.key === 'SENT')).toMatchObject({ count: 1, filter: { status: 'SENT' }, exact: true })
    expect((await ok('buyer', '/home/flow')).lenses.map((lens: Json) => lens.lens)).toEqual(['PURCHASE_ORDERS', 'LOTS'])
    expect((await ok('inspector', '/home/flow')).lenses.map((lens: Json) => lens.lens)).toEqual(['WORK_ORDERS', 'LOTS'])
  })
})

describe('waiting on others', () => {
  it('sales waits for the approval it asked (margin %, never the margin amount); the buyer for its supplier', async () => {
    const sales = await ok('sales', '/home/waiting-on-others')
    expect(sales.items).toHaveLength(1)
    expect(sales.items[0]).toMatchObject({ kind: 'APPROVAL_REQUEST', record: { id: ids.quote }, waitingFor: 'An approver of quotes', ageDays: 1, figures: { netAmount: 624000, marginPct: '14.25' } })
    expect(sales.items[0].figures).not.toHaveProperty('marginAmount')
    expect(sales.items[0].sentence).toContain('(margin 14.3 %)')
    expect(sales.counts).toMatchObject({ total: 1 })
    const buyer = await ok('buyer', '/home/waiting-on-others')
    expect(buyer.items).toHaveLength(1)
    expect(buyer.items[0]).toMatchObject({ kind: 'PO_CONFIRMATION', record: { id: ids.po }, ageDays: 3 })
    expect(buyer.items[0].figures.purchaseAmount).toEqual(expect.any(Number))
    expect((await ok('owner', '/home/waiting-on-others')).items).toEqual([])
  })
})
