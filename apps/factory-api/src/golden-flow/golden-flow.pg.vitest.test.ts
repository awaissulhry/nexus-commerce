import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import { businessDate } from '@nexus/factory-domain/core/time'
import { addDays } from '@nexus/factory-domain/planning/buy'
import { callerFor } from '../core/command'
import { runSdiPoll } from '../modules/invoicing/sdi/poll'
import { processCarrier } from '../modules/shipping/labels/carrier'
import { pollShipment, runTrackingPoll } from '../modules/shipping/labels/poll'
import type { Browser } from '../platform/auth/sessions/testing/harness'
import { systemContext } from '../platform/outbox/system'
import {
  admin,
  announce,
  assertWorkerHandlers,
  drain,
  floorWorker,
  linkBrowser,
  linkTokenSentTo,
  ok,
  pdf,
  person,
  putBytes,
  QUIET,
  signOn,
  startWorld,
  stepped,
  tablet,
  type FloorWorker,
  type Person,
  type World,
} from './testing/world'

/**
 * The API golden flow (B-W1-06a; PLT-072, PLT-123, SCM-189): the first real order, a brand size run for an Italian
 * business customer under its own brand label (Owner answer Q9 (a)), walked THROUGH THE HTTP ROUTES from the customer
 * to the paid invoice, each step by the role that does it in the factory: sales, finance, the planner, the buyer, the
 * warehouse, the production manager, the quality inspector, the floor supervisor and the floor workers on enrolled
 * tablets (badge + PIN), the customer and the supplier through their one-off links. Deposit: an acconto by bank
 * transfer with its TD02 (Q12 (a)); carrier label through the company's own Sendcloud account, FAKE (Q20 (a)); SDI,
 * VIES, SES, R2 and the print relay FAKE too.
 *
 * World (testing/world.ts): a throwaway PostgreSQL 17 database from the migrations, EVERY base seed of
 * packages/factory-db/seed plus the golden-flow scenario (seed/scenarios/golden-flow.ts: what no route makes yet), the
 * real app with the real sign-in, and the worker's handlers (background.ts) run in-process by the real outbox relay
 * after each step (`drain`). The scheduler's two polls (SDI status, carrier tracking) are run as their cron ticks.
 * Each step is one test, in order; a step that needs another lane's work first is an `it.todo` naming why.
 * A second scenario follows in the same world: the EU variant (a German business customer, VIES, N3.2, no TD02).
 * Every name and number is made up. Run with `node scripts/factory/golden-flow.mjs`.
 */

let w: World
const P = {} as Record<'sales' | 'finance' | 'planner' | 'buyer' | 'warehouse' | 'manager' | 'inspector' | 'supervisor' | 'admin', Person>
type Json = Record<string, any>
/** What the flow made, step by step (ids, versions, documents). */
const G = {} as Record<string, any>
/** Every record the flow made: the end checks look for their audit rows and events, and for them on Home. */
const made = new Set<string>()
const keep = (...ids: (string | undefined | null)[]) => ids.forEach((id) => id && made.add(id))
const today = () => businessDate(new Date())

const SIZES = { '50': 2, '52': 4, '54': 2 } as const
const PIECES = Object.values(SIZES).reduce((sum, n) => sum + n, 0)
const CUSTOMER_ORDERS = 'acquisti@marchio-golden.example.com'
const CUSTOMER_INVOICES = 'amministrazione@marchio-golden.example.com'
const CHECKS = ['EN17092_CLASS_LABEL', 'SIZE_LABEL', 'CE_MARK', 'CARE_LABEL', 'FIBRE_COMPOSITION', 'ANIMAL_ORIGIN_PHRASE', 'ZIPS', 'REFLECTIVES', 'ARMOUR_FITTED', 'HANGTAGS', 'USER_INFORMATION', 'PACKAGING']
const MONEY_KEYS = ['unitCost', 'costAmount', 'costSnapshot', 'marginAmount', 'knownTotal']
const keysOf = (value: unknown): string[] =>
  Array.isArray(value) ? value.flatMap(keysOf) : value && typeof value === 'object' ? Object.entries(value).flatMap(([key, item]) => [key, ...keysOf(item)]) : []

const id = (key: string) => w.id(key)
const siteA1 = () => id('site:A1')
const companyA = () => id('company:A')
beforeAll(async () => {
  w = await startWorld()
  for (const [key, role] of [
    ['sales', 'sales'],
    ['finance', 'finance'],
    ['planner', 'planner'],
    ['buyer', 'buyer'],
    ['warehouse', 'warehouse'],
    ['manager', 'production_manager'],
    ['inspector', 'quality_inspector'],
    ['supervisor', 'floor_supervisor'],
    ['admin', 'admin'],
  ] as const) {
    P[key] = await person(w, key, role)
  }
}, 1_200_000)

afterAll(async () => {
  await w?.close()
}, 60_000)

// One step may take a while on a loaded machine (a step signs in several tablets, renders PDFs, runs the worker).
describe('the golden flow: a brand size run from the customer to the paid invoice', { timeout: 180_000 }, () => {
  it('00 the world: the worker handlers are background.ts’s; the base seed and the scenario drain', async () => {
    assertWorkerHandlers()
    await drain(w)
    expect((await ok(P.sales, 'GET', '/auth/office/me')).user.id).toBe(P.sales.id)
  })

  // ---- 01-04 the customer and the style ------------------------------------------------------------------------------------

  it('01 sales makes the customer: an Italian brand with its SDI code, addresses and contacts', async () => {
    const { party } = await ok(
      P.sales,
      'POST',
      '/parties',
      {
        code: 'GF-BRAND',
        legalName: 'Marchio Esempio Golden S.r.l.',
        roles: ['CUSTOMER', 'BRAND'],
        language: 'it',
        paymentTerms: 'Bonifico 30 gg d.f.',
        taxIdentity: { country: 'IT', taxMode: 'IT_B2B', vatNumber: '01234560009', fiscalCode: '01234560009', sdiRecipientCode: 'GFC0DE1', validFrom: '2026-01-01' },
        addresses: [
          { kinds: ['REGISTERED', 'BILL_TO'], line1: 'Via del Marchio 5', postalCode: '50100', city: 'Firenze', province: 'FI', country: 'IT' },
          { kinds: ['SHIP_TO'], name: 'Magazzino', line1: 'Via del Deposito 9', postalCode: '50019', city: 'Sesto Fiorentino', province: 'FI', country: 'IT' },
        ],
        contacts: [
          { name: 'Anna Golden', email: CUSTOMER_ORDERS, roles: ['ORDERS'] },
          { name: 'Bruno Golden', email: CUSTOMER_INVOICES, roles: ['INVOICES'], language: 'it' },
        ],
      },
      201,
    )
    G.party = party
    keep(party.id)
    expect(party.roles).toEqual(expect.arrayContaining(['CUSTOMER', 'BRAND']))
    // An Italian VAT number is not a VIES question (VIES checks EU numbers outside Italy): the route says so.
    const vies = await ok(P.sales, 'POST', `/parties/${party.id}/vies-checks`, { companyId: companyA() }, 409)
    expect(vies.error.message).toMatch(/outside Italy/)
  })

  it('02 the production manager makes the style: one colourway, three sizes, PPE category II, the customer as brand', async () => {
    const { style } = await ok(
      P.manager,
      'POST',
      '/product/styles',
      {
        code: 'GF-JKT-01',
        name: 'Golden touring jacket',
        productType: 'JACKET',
        season: 'FW27',
        brandPartyId: G.party.id,
        sizeScaleId: id('product:size-scale:EU-JKT'),
        sizes: Object.keys(SIZES),
        baseSize: '52',
        ppeCategory: 'CATEGORY_II',
        ppeStandard: 'EN 17092-3:2020',
        ppeClass: 'AA',
        colourways: [{ code: 'RED', name: 'Rosso', colourId: id('product:colour:RED') }],
        generateSkus: true,
      },
      201,
    )
    G.style = style
    G.colourway = style.colourways[0]
    keep(style.id, G.colourway.id)
    expect(style.status).toBe('DRAFT')
    expect(style.skus.length).toBe(3)
    const { revision } = await ok(P.manager, 'POST', `/product/styles/${style.id}/revisions`, { changeNote: 'First revision of the golden jacket' }, 201)
    G.revision = revision
    keep(revision.id)
  })

  it('03 the inspector registers the certificate (PDF, issue) and covers the style', async () => {
    const created = (
      await ok(
        P.inspector,
        'POST',
        '/compliance/certificates',
        {
          holderPartyId: G.party.id,
          standard: 'EN 17092-3:2020',
          ppeClass: 'AA',
          number: 'GF-CERT-0001',
          notifiedBodyName: 'Golden Notified Body (made up)',
          notifiedBodyNumber: '0000',
          modelReference: 'GF-JKT-01',
          validFrom: '2026-01-15',
          validTo: '2030-12-31',
        },
        201,
      )
    ).certificate
    const body = pdf('EU type-examination certificate GF-CERT-0001')
    const announced = await ok(P.inspector, 'POST', `/compliance/certificates/${created.id}/pdf`, announce('certificate.pdf', body), 201)
    await putBytes(w, announced, body)
    const attached = await ok(P.inspector, 'POST', `/compliance/certificates/${created.id}/pdf/${announced.file.id}/complete`)
    expect(attached.certificate.hasPdf).toBe(true)
    const issued = (await ok(P.inspector, 'POST', `/compliance/certificates/${created.id}/issue`, { version: attached.certificate.version })).certificate
    expect(issued.status).toBe('VALID')
    const covered = await ok(P.inspector, 'POST', `/compliance/certificates/${created.id}/coverage`, { version: issued.version, styleId: G.style.id }, 201)
    G.certificate = covered.certificate
    keep(created.id)
    const gate = await ok(P.inspector, 'POST', '/compliance/certificates/gate', { styleId: G.style.id, colourwayId: G.colourway.id, size: '52' })
    expect(gate).toMatchObject({ allowed: true, outcome: 'covered' })
  })

  it('04 the inspector makes the garment label, activates it and names it on the draft revision', async () => {
    const { template } = await ok(
      P.inspector,
      'POST',
      '/compliance/labels',
      {
        styleId: G.style.id,
        languages: ['it', 'en'],
        composition: [
          { part: 'shell', fibres: [{ fibre: 'leather (not a textile)', percent: '100' }] },
          { part: 'lining', fibres: [{ fibre: 'polyester', percent: '100' }] },
        ],
        animalOriginPhrase: true,
        care: [{ symbol: 'wash-not' }, { symbol: 'bleach-not' }, { symbol: 'iron-not' }, { symbol: 'dryclean-professional' }],
        layout: { fields: ['ceMark', 'pictogram', 'standard', 'model', 'size', 'bodyMeasures', 'batchOrSerial', 'maker'] },
      },
      201,
    )
    const active = (await ok(P.inspector, 'POST', `/compliance/labels/${template.id}/activate`, { version: template.version })).template
    expect(active.status).toBe('ACTIVE')
    const named = await ok(P.inspector, 'PUT', `/product/styles/${G.style.id}/revisions/${G.revision.id}/label`, { labelTemplateId: template.id, version: G.revision.version })
    expect(named.revision.labelTemplateId).toBe(template.id)
    G.revision = { ...G.revision, version: named.revision.version }
    G.label = active
    keep(template.id)
  })

  it('05 the production manager builds the BOM and the routing on the draft and releases the revision: the style is ACTIVE', async () => {
    const path = `/product/styles/${G.style.id}/revisions/${G.revision.id}`
    let version = G.revision.version as number
    const line = async (body: Json) => {
      const { bom } = await ok(P.manager, 'POST', `${path}/bom/lines`, { version, ...body }, 201)
      version = bom.revision.version
      return bom
    }
    await line({
      itemId: id('product:item:leather'),
      placement: 'Outer shell',
      uom: 'FT2',
      wastagePct: '5',
      sizeDependent: true,
      sizes: [
        { size: '50', qty: '20' },
        { size: '52', qty: '21' },
        { size: '54', qty: '22' },
      ],
      colourDependent: true,
      colours: [{ colourwayId: G.colourway.id, itemColourId: id('product:item-colour:leather:RED') }],
    })
    await line({ itemId: id('product:item:lining'), placement: 'Body lining', qty: '1.8', wastagePct: '5', itemColourId: id('product:item-colour:lining:GRY') })
    await line({ itemId: id('product:item:protector'), placement: 'Shoulder pockets', qty: '2' })
    version = (await ok(P.manager, 'PATCH', path, { version, plannedHideYieldPct: '75' })).bom.revision.version
    const { routing } = await ok(
      P.manager,
      'POST',
      `${path}/routing/steps`,
      { version, operations: ['CUT', 'SEW', 'QC', 'PACK'].map((code) => ({ operationId: id(`product:operation:${code}`) })) },
      201,
    )
    version = routing.revision.version
    const bom = (await ok(P.manager, 'GET', `${path}/bom`)).bom
    expect(bom).toMatchObject({ releasable: true, issues: [] })
    const released = (await ok(P.manager, 'POST', `${path}/release`, { version, changeNote: 'Golden jacket, first release' })).bom
    expect(released.style.status).toBe('ACTIVE')
    expect(released.revision.status).toBe('RELEASED')
    G.revision = released.revision
  })

  it('06 the inspector files the signed DoC and the user information (it, en) for the released revision', async () => {
    for (const kind of ['DECLARATION_OF_CONFORMITY', 'USER_INFORMATION']) {
      for (const language of ['it', 'en']) {
        const body = pdf(`${kind} ${language} GF-JKT-01 rev 1`)
        const announced = await ok(P.inspector, 'POST', `/product/styles/${G.style.id}/compliance/documents`, { revisionId: G.revision.id, kind, language, ...announce(`${kind.toLowerCase()}-${language}.pdf`, body) }, 201)
        await putBytes(w, announced, body)
        const confirmed = await ok(P.inspector, 'POST', `/product/styles/${G.style.id}/compliance/documents/${announced.document.id}/files/${announced.file.id}/complete`)
        expect(confirmed.document.status).toBe('ISSUED')
        keep(announced.document.id)
      }
    }
    const compliance = (await ok(P.inspector, 'GET', `/product/styles/${G.style.id}/compliance?revisionId=${G.revision.id}`)).compliance
    expect(compliance.blockers ?? []).toEqual([])
  })

  it('07 finance reads the cost sheet (complete, not an estimate); the production manager sees no cost figure', async () => {
    const url = `/costing/styles/${G.style.id}/revisions/${G.revision.id}/cost-sheet`
    const sheet = (await ok(P.finance, 'GET', url)).sheet
    expect(sheet).toMatchObject({ complete: true, estimate: false, currency: 'EUR', missing: [] })
    expect(sheet.cells.length).toBe(3)
    const blind = (await ok(P.manager, 'GET', url)).sheet
    expect(keysOf(blind).filter((key) => /cost|total|amount/i.test(key) && !/missing|complete/i.test(key))).toEqual([])
    await drain(w)
  })

  // ---- 08-11 quote, acceptance, deposit, order -------------------------------------------------------------------------------

  it('08 sales quotes the size run; the discount over the limit asks finance, who approves it (Home shows it to finance meanwhile)', async () => {
    let { quote } = await ok(P.sales, 'POST', '/sales/quotes', { companyId: companyA(), partyId: G.party.id, customerRef: 'RFQ-GOLDEN-1', promiseDate: addDays(today(), 60) }, 201)
    keep(quote.id, quote.current?.id)
    ;({ quote } = await ok(
      P.sales,
      'POST',
      `/sales/quotes/${quote.id}/lines`,
      {
        version: quote.version,
        styleId: G.style.id,
        colourwayId: G.colourway.id,
        sizes: Object.entries(SIZES).map(([size, quantity]) => ({ size, quantity })),
        listUnitPrice: '500',
        discountPct: '20',
      },
      201,
    ))
    expect(quote.approval.needed).toBe(true)
    expect(quote.sendBlockers.map((issue: Json) => issue.code ?? issue)).toEqual(['APPROVAL_NEEDED'])
    // Money grains: sales sees the price and the margin %, never a cost; finance sees the cost and the margin amount.
    expect(keysOf(quote).filter((key) => MONEY_KEYS.includes(key))).toEqual([])
    expect(quote.current.marginPct).toEqual(expect.any(String))
    const forFinance = (await ok(P.finance, 'GET', `/sales/quotes/${quote.id}`)).quote
    expect(forFinance.current.costAmount).toEqual(expect.any(Number))
    expect(forFinance.current.marginAmount).toBe(forFinance.current.netAmount - forFinance.current.costAmount)

    ;({ quote } = await ok(P.sales, 'POST', `/sales/quotes/${quote.id}/approval`, { version: quote.version, note: 'First order of a new brand: 20% launch discount' }))
    expect(quote.status).toBe('PENDING_APPROVAL')
    const asked = (await ok(P.finance, 'GET', '/home/today?limit=200')).items as Json[]
    expect(asked.filter((item) => item.record.id === quote.id).map((item) => item.kind)).toEqual(['QUOTE_APPROVAL'])
    // The one who asked never decides.
    await ok(P.sales, 'POST', `/sales/quotes/${quote.id}/approval/approve`, { version: quote.version }, 403)
    const decided = await ok(P.finance, 'POST', `/sales/quotes/${quote.id}/approval/approve`, { version: quote.version, note: 'Approved for the launch' })
    expect(decided.decision.status).toEqual({ from: 'PENDING_APPROVAL', to: 'APPROVED' })
    G.quote = decided.quote
    expect((await ok(P.finance, 'GET', '/home/today?limit=200')).items.filter((item: Json) => item.record.id === quote.id)).toEqual([])
    await drain(w)
  })

  it('09 sales sends the quote: a frozen version, its PDF, and the accept link mailed to the customer', async () => {
    const check = await ok(P.sales, 'GET', `/sales/quotes/${G.quote.id}/send-check`)
    expect(check).toMatchObject({ ready: true, recipient: { email: CUSTOMER_ORDERS } })
    expect(check.checks.filter((entry: Json) => entry.severity === 'BLOCKS')).toEqual([])
    const sent = await ok(P.sales, 'POST', `/sales/quotes/${G.quote.id}/send`, { version: G.quote.version })
    expect(sent).toMatchObject({ quote: { status: 'SENT' }, sent: { to: CUSTOMER_ORDERS, documentSha256: expect.stringMatching(/^[0-9a-f]{64}$/) }, delivery: 'sent' })
    G.quote = sent.quote
    G.sent = sent.sent
    keep(sent.sent.versionId, sent.sent.documentFileId)
    await drain(w)
  })

  it('10 the customer opens the link and accepts with a typed name: deposit request and sales order made at once', async () => {
    const customer = linkBrowser(w, linkTokenSentTo(w, CUSTOMER_ORDERS))
    const page = await customer.send('GET', '/link/quote')
    expect(page).toMatchObject({ state: 'OPEN', quote: { versionId: G.sent.versionId } })
    expect(page.quote.lines.length).toBe(1)
    const accepted = await customer.send('POST', '/link/quote/accept', { versionId: G.sent.versionId, typedName: 'Anna Golden', email: CUSTOMER_ORDERS })
    expect(accepted).toMatchObject({ state: 'ACCEPTED', deposit: { kind: 'ACCONTO', fiscalDocument: 'TD02', status: 'OPEN', instructions: { method: 'BANK_TRANSFER' } } })
    G.deposit = accepted.deposit
    keep(accepted.deposit.id)
    // The link is used up: a second answer finds nothing.
    await customer.send('POST', '/link/quote/accept', { versionId: G.sent.versionId, typedName: 'Anna Golden', email: CUSTOMER_ORDERS }, 404)
    const { orders } = await ok(P.sales, 'GET', `/sales/orders?partyId=${G.party.id}`)
    expect(orders.length).toBe(1)
    G.order = (await ok(P.sales, 'GET', `/sales/orders/${orders[0].id}`)).order
    keep(G.order.id, ...G.order.lines.map((line: Json) => line.id))
    expect(G.order).toMatchObject({ status: 'CONFIRMED', depositRequired: true })
    expect(G.order.lines[0].sizes.map((size: Json) => [size.size, size.quantity])).toEqual(Object.entries(SIZES))
    await drain(w)
  })

  it('10b finance mails the deposit page (DEPOSIT_INFO link): the customer reads amount, due date, reference and bank details', async () => {
    const before = w.h.ses.mails.length
    const sent = await ok(P.finance, 'POST', `/payments/deposit-requests/${G.deposit.id}/link`, {}, 201)
    expect(sent).toMatchObject({ link: { to: CUSTOMER_ORDERS, revokedLinkIds: [] }, delivery: 'sent' })
    expect(JSON.stringify(sent)).not.toMatch(/#token=/)
    const mail = w.h.ses.mails.slice(before).find((entry) => entry.outboundId === sent.emailId)!
    expect(mail.to).toEqual([CUSTOMER_ORDERS])
    // The thread keeps the text without the link; only the sent mail holds it.
    expect(await admin(w, `SELECT count(*)::int AS n FROM "Message" WHERE "bodyText" LIKE '%#token=%'`)).toEqual([{ n: 0 }])
    const customer = linkBrowser(w, linkTokenSentTo(w, CUSTOMER_ORDERS))
    const page = await customer.send('GET', '/payments/link/deposit')
    expect(page).toMatchObject({
      deposit: { kind: 'ACCONTO', status: 'OPEN', amount: G.deposit.amount, paid: false },
      order: { number: G.order.number },
      instructions: { method: 'BANK_TRANSFER', amount: G.deposit.amount, bank: { iban: expect.stringMatching(/^IT/) } },
    })
    expect(page.instructions.reference).toContain(page.quote.document)
    await customer.send('POST', '/link/open', {})
    // The link opens this request only: another purpose's page is not there for it.
    await customer.send('GET', '/link/quote', undefined, 404)
    keep(sent.link.id)
    await drain(w)
  })

  it('11 finance records the deposit received by bank transfer: the request is PAID and the TD02 issued with its XML and PDF', async () => {
    await stepped(w, P.finance)
    const received = await ok(P.finance, 'POST', '/payments/deposit-received', { depositRequestId: G.deposit.id, amount: G.deposit.amount, receivedOn: today(), externalRef: 'CRO-GOLDEN-0001' }, 201)
    expect(received).toMatchObject({
      depositRequest: { status: 'PAID' },
      depositInvoice: { required: true, invoice: { docType: 'TD02', status: 'ISSUED', xmlFileId: expect.any(String), pdfFileId: expect.any(String) }, filesPending: false },
    })
    G.td02 = received.depositInvoice.invoice
    keep(received.payment.id, G.td02.id)
    // A paid request has nothing left to pay: no new deposit page.
    expect((await ok(P.finance, 'POST', `/payments/deposit-requests/${G.deposit.id}/link`, {}, 409)).error.message).toMatch(/is PAID/)
    await drain(w)
  })

  it('12 the order reads as one record: lines per size, the deposit paid, the TD02 in its chain; sales sees no cost', async () => {
    const order = (await ok(P.sales, 'GET', `/sales/orders/${G.order.id}`)).order
    expect(order.chain.depositRequests.map((request: Json) => request.status)).toEqual(['PAID'])
    expect(order.chain.invoices.map((invoice: Json) => invoice.id ?? invoice.invoiceId)).toContain(G.td02.id)
    expect(order).not.toHaveProperty('costAmount')
    expect(order.lines[0]).not.toHaveProperty('unitCost')
    const forFinance = (await ok(P.finance, 'GET', `/sales/orders/${G.order.id}`)).order
    expect(forFinance.costAmount).toEqual(expect.any(Number))
  })

  // ---- 13-17 planning, buying, receiving, the lab -------------------------------------------------------------------------------

  it('13 the planner runs the plan for A1: the order’s red leather is a BUY line from the supplier', async () => {
    const { run } = await ok(P.planner, 'POST', '/planning/runs', { siteId: siteA1(), note: 'Golden flow' }, 201)
    expect(run.status).toBe('DONE')
    keep(run.id)
    const lines = async (itemKey: string) => (await ok(P.planner, 'GET', `/planning/runs/latest?siteId=${siteA1()}&itemId=${id(itemKey)}&shortOnly=true`)).lines as Json[]
    const red = (await lines('product:item:leather')).find((line) => line.colour?.id === id('product:item-colour:leather:RED'))
    expect(red).toMatchObject({ action: 'BUY', decision: 'OPEN', supplier: { id: id('party:P2') } })
    expect(red!.sources.map((source: Json) => source.orderNumber)).toContain(G.order.number)
    // The shoulder protectors are not short for the plan: the seeded order SEED-PO-0001 has them on order. None is on
    // hand at A1, though, so the buyer adds them to the new order by hand (next step).
    expect(await lines('product:item:protector')).toEqual([])
    // B-W2a-22: the run carries the seeded plan's firm planned order of red leather (4 hides for the seeded order);
    // the planner makes the line planned again, so the buyer buys what the plan suggests for every order.
    expect(red!.firm).toMatchObject({ quantity: '4.0000', uom: 'HIDE', carried: true })
    G.planLine = (await ok(P.planner, 'POST', `/planning/requirements/${red!.id}/unfirm`, { version: red!.version })).line
    expect(G.planLine).toMatchObject({ firm: null, suggestedQuantity: red!.suggestedQuantity })
  })

  it('14 the buyer orders the leather from the plan, adds the protectors and sends the PO: PDF and confirm link to the supplier', async () => {
    const drafted = await ok(P.buyer, 'POST', '/purchasing/from-plan', { lines: [{ id: G.planLine.id, version: G.planLine.version }], into: [{ supplierId: id('party:P2'), purchaseOrderId: null }] })
    expect(drafted.orders.length).toBe(1)
    let order = (await ok(P.buyer, 'GET', `/purchasing/orders/${drafted.orders[0].id}`)).order
    keep(order.id)
    // 36 = three of the supplier's multiples of 12: this order's 16 and the 14 the seeded work order still waits for.
    order = (await ok(P.buyer, 'POST', `/purchasing/orders/${order.id}/lines`, { version: order.version, itemId: id('product:item:protector'), quantity: '36', uom: 'PCS', needDate: addDays(today(), 40) }, 201)).order
    expect(order.lines.length).toBe(2)
    // The plan's need date is the seeded order's (already near): the buyer asks for the goods in 40 days.
    for (const line of order.lines as Json[]) {
      order = (await ok(P.buyer, 'PATCH', `/purchasing/orders/${order.id}/lines/${line.id}`, { version: order.version, needDate: addDays(today(), 40), ...(line.uom === 'HIDE' ? { areaTolerancePct: '5' } : {}) })).order
    }
    const check = await ok(P.buyer, 'GET', `/purchasing/orders/${order.id}/send-check`)
    expect(check.checks.filter((entry: Json) => entry.severity === 'BLOCKS')).toEqual([])
    const sent = await ok(P.buyer, 'POST', `/purchasing/orders/${order.id}/send`, { version: order.version })
    expect(sent).toMatchObject({ order: { status: 'SENT' }, delivery: 'sent' })
    G.po = sent.order
    G.poRecipient = sent.sent.to
    await drain(w)
  })

  it('15 the supplier opens the link (no price) and confirms every line as asked', async () => {
    const supplier = linkBrowser(w, linkTokenSentTo(w, G.poRecipient))
    const page = await supplier.send('GET', '/link/purchase-order')
    expect(page).toMatchObject({ order: { id: G.po.id, status: 'SENT' }, canAnswer: true })
    expect(keysOf(page).filter((key) => /price|cost|amount/i.test(key))).toEqual([])
    const answered = await supplier.send('POST', '/link/purchase-order/confirm', { version: page.order.version, mode: 'ALL_AS_ASKED', typedName: 'Mario Fornitore', supplierRef: 'OC-GOLDEN-1' })
    expect(answered).toMatchObject({ outcome: 'CONFIRMED', order: { status: 'CONFIRMED' } })
    expect((await ok(P.buyer, 'GET', `/purchasing/orders/${G.po.id}/answer`)).answer).toBe('CONFIRMED')
    G.po = (await ok(P.buyer, 'GET', `/purchasing/orders/${G.po.id}`)).order
    await drain(w)
  })

  it('16 the warehouse receives both lines: the leather hide by hide (Cr VI test), the protectors by the lot (PPE certificate)', async () => {
    const lineOf = (itemKey: string) => (G.po.lines as Json[]).find((line) => (line.item?.id ?? line.itemId) === id(itemKey))!
    const leather = lineOf('product:item:leather')
    const protector = lineOf('product:item:protector')
    const hides = Number(leather.confirmedQuantity ?? leather.quantity)
    const received = await ok(
      P.warehouse,
      'POST',
      '/inventory/receipts',
      {
        purchaseOrderId: G.po.id,
        supplierDdtNumber: 'DDT-GOLDEN-01',
        supplierDdtDate: today(),
        lines: [
          {
            purchaseOrderLineId: leather.id,
            lots: [{ supplierLotRef: 'TAN-GOLDEN', dyeBatch: 'DB-GF-01', shade: 'Rosso 01', hides: Array.from({ length: hides }, (_, n) => ({ supplierCode: `T-${n + 1}`, area: '52.5', grade: 'A', thicknessMm: '1.2' })) }],
          },
          { purchaseOrderLineId: protector.id, lots: [{ supplierLotRef: 'PRO-GOLDEN', quantity: String(Number(protector.confirmedQuantity ?? protector.quantity)) }] },
        ],
      },
      201,
    )
    expect(received.receipt).toMatchObject({ status: 'POSTED', purchaseOrder: { status: 'RECEIVED' } })
    const [leatherLot, protectorLot] = [leather, protector].map((line) => (received.receipt.lines as Json[]).find((entry) => entry.orderLine?.id === line.id || entry.purchaseOrderLineId === line.id)?.lots[0])
    expect(leatherLot).toMatchObject({ qualityStatus: 'QUARANTINE', holds: ['CR_VI_TEST'], crViStatus: 'PENDING' })
    expect(protectorLot).toMatchObject({ qualityStatus: 'QUARANTINE', holds: ['PPE_CERTIFICATE'] })
    G.receipt = received.receipt
    G.lot = leatherLot
    G.protectorLot = protectorLot
    const lots = (await ok(P.warehouse, 'GET', `/inventory/receipts/${received.receipt.id}/lots`)).lots as Json[]
    G.hides = lots.find((lot) => lot.id === leatherLot!.id)!.hides
    expect(G.hides.length).toBe(hides)
    keep(received.receipt.id, leatherLot.id, protectorLot.id, ...G.hides.map((hide: Json) => hide.id))
    await drain(w)
  })

  it('17 the inspector releases both lots (not the receiver): Cr VI result with the lab report; the protectors’ PPE certificate', async () => {
    const base = `/quality/lots/${G.lot.id}`
    let lot = (await ok(P.inspector, 'GET', base)).lot
    // Four eyes: the lots were received by the warehouse, the inspector releases them.
    expect(lot.receivedById).toBe(P.warehouse.id)
    const report = pdf('Cr VI test report TL-GOLDEN-1')
    const announced = await ok(P.inspector, 'POST', `${base}/results/report`, announce('cr6.pdf', report), 201)
    await putBytes(w, announced, report)
    const recorded = await ok(
      P.inspector,
      'POST',
      `${base}/results`,
      { version: lot.version, test: 'CR_VI', method: 'EN ISO 17075-1', valueMgKg: '1.2', lab: 'Test Lab One (made up)', reportNumber: 'TL-GOLDEN-1', testedOn: today(), evidence: 'LOT_REPORT', fileId: announced.file.id },
      201,
    )
    expect(recorded).toMatchObject({ result: { verdict: 'PASS' }, checklist: { ready: true } })
    lot = recorded.lot
    expect((await ok(P.inspector, 'POST', `${base}/release`, { version: lot.version, confirmCode: lot.code })).lot.qualityStatus).toBe('RELEASED')

    const protectors = `/quality/lots/${G.protectorLot.id}`
    const certificate = pdf('EN 1621-1 certificate of the shoulder protector lot PRO-GOLDEN')
    const upload = await ok(P.inspector, 'POST', `${protectors}/documents/upload`, announce('ppe-certificate.pdf', certificate), 201)
    await putBytes(w, upload, certificate)
    const attached = await ok(P.inspector, 'POST', `${protectors}/documents`, { fileId: upload.file.id, kind: 'PPE_CERTIFICATE', validTo: '2030-05-31' }, 201)
    expect(attached.documents).toMatchObject([{ kind: 'PPE_CERTIFICATE', inForce: true }])
    const check = await ok(P.inspector, 'GET', `${protectors}/release-check`)
    expect(check.checklist).toMatchObject({ ready: true, open: [] })
    expect((await ok(P.inspector, 'POST', `${protectors}/release`, { version: check.lot.version, confirmCode: check.lot.code })).lot.qualityStatus).toBe('RELEASED')
    await drain(w)
  })

  // ---- 18-25 production --------------------------------------------------------------------------------------------------------

  it('18 the planner makes the work order from the order line and releases it: the order follows (IN_PRODUCTION)', async () => {
    const { workOrder } = await ok(P.planner, 'POST', '/production/work-orders', { lines: [{ salesOrderLineId: G.order.lines[0].id }] }, 201)
    keep(workOrder.id)
    const check = await ok(P.planner, 'GET', `/production/work-orders/${workOrder.id}/release-check`)
    // Every check passes: revision, label, certificate, work centres, BOM, cells, the deposit paid, the materials in stock.
    expect(check).toMatchObject({ releasable: true, blockers: [] })
    const released = (await ok(P.planner, 'POST', `/production/work-orders/${workOrder.id}/release`, { version: workOrder.version })).workOrder
    expect(released).toMatchObject({ status: 'RELEASED', batchNumber: expect.any(String) })
    G.wo = released
    await drain(w)
    expect((await ok(P.sales, 'GET', `/sales/orders/${G.order.id}`)).order.status).toBe('IN_PRODUCTION')
  })

  it('19 the supervisor enrols a tablet per station and four floor workers (badge, PIN, notice); the admin adds the garment label printer', async () => {
    const roleId = id('role:operator')
    G.tablets = {} as Record<string, Browser>
    G.workers = {} as Record<string, FloorWorker>
    const pins = { CUTTING: '481537', SEWING: '592648', INSPECTION: '603759', PACKING: '714860' } as const
    G.pins = pins
    for (const [kind, station] of [
      ['CUTTING', 'CUT-01'],
      ['SEWING', 'SEW-01'],
      ['INSPECTION', 'QC-01'],
      ['PACKING', 'PACK-01'],
    ] as const) {
      const device = await tablet(w, P.supervisor, siteA1(), id(`site:A1:station:${station}`), `Golden tablet ${station}`)
      const worker = await floorWorker(w, P.supervisor, siteA1(), `Golden ${kind.toLowerCase()} worker`, roleId)
      await signOn(device, worker, pins[kind])
      G.tablets[kind] = device
      G.workers[kind] = worker
      keep(worker.id)
    }
    const { printer } = await ok(
      P.admin,
      'POST',
      '/print/printers',
      { siteId: siteA1(), code: 'LBL-GF', name: 'Golden garment label printer', kind: 'LABEL_ZPL', relay: 'FAKE', relayTarget: 'golden-label:9100', dpi: 203, labelWidthMm: 100, labelHeightMm: 100 },
      201,
    )
    G.garmentPrinter = printer.id
  })

  it('20 pick and issue: the cutting tablet reads the pick list and issues the received hides to the work order', async () => {
    const cutting = G.tablets.CUTTING as Browser
    const pick = await ok(cutting, 'GET', `/inventory/picking/work-orders/${G.wo.id}`)
    const leather = (pick.lines as Json[]).find((line) => line.itemId === id('product:item:leather'))
    const ours = new Set(G.hides.map((hide: Json) => hide.code))
    expect(leather!.usable.candidates.some((candidate: Json) => ours.has(candidate.hideCode))).toBe(true)
    G.cutHides = G.hides.slice(0, 4)
    for (const hide of G.cutHides) {
      const issued = await ok(cutting, 'POST', `/inventory/picking/work-orders/${G.wo.id}/issue`, { code: hide.code }, 201)
      expect(Number(issued.issue.baseQuantity)).toBeGreaterThan(0)
    }
    await drain(w)
  })

  it('21 cutting per hide on the floor: two sets of one size per hide, each hide used up', async () => {
    const cutting = G.tablets.CUTTING as Browser
    const cells = (G.wo.cells as Json[]).map((cell) => ({ id: cell.id, size: cell.size, left: cell.quantity }))
    for (const hide of G.cutHides as Json[]) {
      const cell = cells.find((entry) => entry.left > 0)!
      const sets = Math.min(2, cell.left)
      const cut = await ok(cutting, 'POST', `/production/cutting/work-orders/${G.wo.id}/cuts`, { clientEventId: `gf-cut-${hide.code}`, code: hide.code, lines: [{ workOrderSizeId: cell.id, sets }], done: { remnant: null } }, 201)
      expect(cut.hide.state).toBe('CONSUMED')
      cell.left -= sets
    }
    expect(cells.map((cell) => cell.left)).toEqual([0, 0, 0])
    await drain(w)
  })

  it('22 bundles and their tickets at the cutting table (the seeded ticket printer)', async () => {
    const made = await ok(G.tablets.CUTTING, 'POST', `/production/bundles/work-orders/${G.wo.id}/bundles`, { bundleSize: 10, printerId: id('print:printer:A1:LBL') }, 201)
    expect(made.bundles.map((bundle: Json) => [bundle.size, bundle.quantity]).sort()).toEqual(Object.entries(SIZES))
    expect(made.tickets.every((ticket: Json) => ticket.problem === null || ticket.problem === undefined)).toBe(true)
    G.bundles = made.bundles
    keep(...made.bundles.map((bundle: Json) => bundle.id))
    await drain(w)
    expect(w.printer.jobs.length).toBeGreaterThanOrEqual(made.bundles.length)
  })

  it('23 every bundle is reported through every operation, each at its own station: all garments finished', async () => {
    const operations = (G.wo.spec.operations as Json[]).filter((op) => op.scanRequired).sort((a, b) => a.seq - b.seq)
    expect(operations.map((op) => op.workCentreKind)).toEqual(['CUTTING', 'SEWING', 'INSPECTION', 'PACKING'])
    let n = 0
    for (const bundle of G.bundles as Json[]) {
      for (const op of operations) {
        const clientScanId = `gf-scan-${++n}-${bundle.code}`
        const scan = await ok(G.tablets[op.workCentreKind], 'POST', '/production/scans', { clientScanId, code: bundle.code, workOrderOperationId: op.id, good: bundle.quantity }, 201, { 'idempotency-key': clientScanId })
        expect(scan.scan.goodQuantity).toBe(bundle.quantity)
      }
    }
    const wip = await ok(P.planner, 'GET', `/production/scans/work-orders/${G.wo.id}/wip`)
    expect(wip).toMatchObject({ allFinished: true, readyToComplete: true })
    await drain(w)
  })

  it('24 the garment labels (batch number) are printed at the packing bench', async () => {
    const printed = await ok(G.tablets.PACKING, 'POST', `/production/serials/work-orders/${G.wo.id}/labels`, { printerId: G.garmentPrinter }, 201)
    expect(printed).toMatchObject({ tracking: 'BATCH', refused: [] })
    expect(printed.printed.reduce((sum: number, entry: Json) => sum + entry.count, 0)).toBe(PIECES)
    expect(new Set(printed.printed.map((entry: Json) => entry.batchNumber))).toEqual(new Set([G.wo.batchNumber]))
    // Q31: the style's numbering (BATCH, set until now) no longer changes once its garments carry labels.
    const style = (await ok(P.manager, 'GET', `/product/styles/${G.style.id}`)).style
    expect(style.garmentTracking).toBe('BATCH')
    const flip = await ok(P.manager, 'PUT', `/product/styles/${G.style.id}/garment-tracking`, { version: style.version, tracking: 'SERIAL' }, 409)
    expect(flip.error.message).toMatch(/^Style GF-JKT-01 has work orders with garment labels printed: its garments stay numbered by batch \(Q31\)/)
    await drain(w)
  })

  it('25 the planner completes the work order', async () => {
    const done = (await ok(P.planner, 'POST', `/production/work-orders/${G.wo.id}/complete`, {})).workOrder
    expect(done.status).toBe('COMPLETED')
    G.wo = { ...G.wo, ...done, spec: G.wo.spec }
    await drain(w)
  })

  it('26 final inspection and release by an inspector who made none of the garments', async () => {
    const before = await ok(P.inspector, 'GET', `/quality/final/work-orders/${G.wo.id}`)
    expect(before.maker?.made ?? false).toBe(false)
    const opened = (
      await ok(P.inspector, 'POST', '/quality/inspections', { workOrderId: G.wo.id, lotSize: PIECES, sampleSize: PIECES, inspectionLevel: 'II', aqlMajor: '2.5', aqlMinor: '4.0', acceptMajor: 0, acceptMinor: 1 }, 201)
    ).inspection
    await stepped(w, P.inspector)
    const decided = (await ok(P.inspector, 'POST', `/quality/inspections/${opened.id}/decide`, { version: opened.version, result: 'PASS', checklist: CHECKS.map((code) => ({ code, ok: true })) })).inspection
    expect(decided).toMatchObject({ status: 'PASSED', computed: { result: 'PASS' }, overridden: false })
    keep(opened.id)
    G.releases = []
    for (const cell of G.wo.cells as Json[]) {
      await stepped(w, P.inspector)
      const { release } = await ok(P.inspector, 'POST', '/quality/releases', { inspectionId: opened.id, workOrderSizeId: cell.id, quantity: cell.quantity }, 201)
      expect(release).toMatchObject({ quantity: cell.quantity, releasedBy: { kind: 'OFFICE', userId: P.inspector.id } })
      G.releases.push(release)
      keep(release.id)
    }
    await drain(w)
  })

  // ---- 27-31 shipping ------------------------------------------------------------------------------------------------------------

  it('27 the warehouse ships what was released: shipment, one parcel, packed', async () => {
    const ready = await ok(P.warehouse, 'GET', `/shipping/ready?salesOrderId=${G.order.id}`)
    const cells = (ready.orders as Json[]).flatMap((order) => order.cells as Json[])
    expect(cells.reduce((sum, cell) => sum + cell.shippable, 0)).toBe(PIECES)
    let { shipment } = await ok(P.warehouse, 'POST', '/shipping/shipments', { salesOrderId: G.order.id, lines: cells.map((cell) => ({ workOrderSizeId: cell.workOrderSizeId, quantity: cell.shippable })) }, 201)
    keep(shipment.id)
    const parcel = await ok(P.warehouse, 'POST', `/shipping/packing/${shipment.id}/parcels`, { grossWeightKg: '14.5', lengthCm: '60', widthCm: '40', heightCm: '40' }, 201)
    for (const line of shipment.lines as Json[]) {
      shipment = (await ok(P.warehouse, 'PUT', `/shipping/packing/${shipment.id}/lines/${line.id}/parcel`, { parcelId: parcel.parcelId })).shipment
    }
    shipment = (await ok(P.warehouse, 'POST', `/shipping/packing/${shipment.id}/pack`, {})).shipment
    expect(shipment).toMatchObject({ status: 'PACKED', packingProblems: [] })
    G.shipment = shipment
    G.parcelId = parcel.parcelId
    keep(parcel.parcelId)
    await drain(w)
  })

  it('28 the DDT is issued (number, PDF in the fiscal archive); the DoC and leaflet are on file for the shipment', async () => {
    const preview = await ok(P.warehouse, 'POST', `/shipping/shipments/${G.shipment.id}/ddt/preview`, {})
    expect(preview.problems).toEqual([])
    const issued = await ok(P.warehouse, 'POST', `/shipping/shipments/${G.shipment.id}/ddt`, {}, 201)
    expect(issued).toMatchObject({ ddt: { status: 'LIVE', fileId: expect.any(String) }, shipment: { status: 'PACKED' } })
    G.ddt = issued.ddt
    keep(issued.ddt.id)
    const documents = (await ok(P.warehouse, 'GET', `/shipping/shipments/${G.shipment.id}/documents`)).documents
    expect(documents.blockers).toEqual([])
    await drain(w)
  })

  it('29 the carrier label through the company’s Sendcloud account (FAKE): tracking number and label file', async () => {
    const bought = await ok(P.warehouse, 'POST', `/shipping/shipments/${G.shipment.id}/labels`, {}, 201)
    expect(bought.problem ?? null).toBeNull()
    G.tracking = bought.parcels[0].trackingNumber
    expect(G.tracking).toEqual(expect.any(String))
    expect(bought.parcels[0].files.length).toBeGreaterThan(0)
    await drain(w)
  })

  it('30 shipped: the worker sends the DoC and leaflet by link to the customer and moves the order to SHIPPED', async () => {
    const shipped = (await ok(P.warehouse, 'POST', `/shipping/shipments/${G.shipment.id}/ship`, {})).shipment
    expect(shipped.status).toBe('SHIPPED')
    const before = w.h.ses.mails.length
    const handled = await drain(w)
    expect(handled).toContain('shipment.status_changed')
    const documents = (await ok(P.warehouse, 'GET', `/shipping/shipments/${G.shipment.id}/documents`)).documents
    expect(documents.documents.filter((document: Json) => document.state === 'ATTACHED').length).toBeGreaterThanOrEqual(3)
    expect(w.h.ses.mails.slice(before).some((mail) => mail.to.includes(CUSTOMER_ORDERS))).toBe(true)
    expect((await ok(P.sales, 'GET', `/sales/orders/${G.order.id}`)).order.status).toBe('SHIPPED')
  })

  it('31 delivered: the scheduler’s tracking poll finds the carrier’s events, the worker records them', async () => {
    // The carrier's events after its label event (stamped on the fake's clock, the harness's): never posted to us.
    const after = Math.max(Date.now(), w.h.clock.now().getTime())
    w.sendcloud.advance(G.tracking, 'IN_TRANSIT', 'unused', new Date(after + 60_000))
    w.sendcloud.advance(G.tracking, 'DELIVERED', 'unused', new Date(after + 120_000))
    const tick = await runTrackingPoll({ database: w.h.database, log: QUIET, clock: { now: () => new Date(Date.now() + 12 * 3_600_000 + 5 * 60_000) } })
    expect(tick).toMatchObject({ shipments: 1, failed: 0 })
    expect(await drain(w)).toContain('shipment.tracking_poll_due')
    const tracking = await ok(P.warehouse, 'GET', `/shipping/shipments/${G.shipment.id}/tracking`)
    expect(tracking.shipment.status).toBe('DELIVERED')
  })

  // ---- 32-35 invoice, SDI, payment, settlement ---------------------------------------------------------------------------------

  it('32 finance invoices the DDT: TD01 within its 12 days, the TD02 deducted; issued with its XML and PDF', async () => {
    const queue = await ok(P.finance, 'GET', `/invoicing/shipped-not-invoiced?partyId=${G.party.id}`)
    const ddt = (queue.customers as Json[]).flatMap((customer) => customer.ddts as Json[]).find((entry) => entry.ddtId === G.ddt.id)
    expect(ddt).toMatchObject({ immediate: { docType: 'TD01' } })
    // Home tells finance the shipped goods wait for an invoice.
    const waiting = (await ok(P.finance, 'GET', '/home/today?limit=200')).items as Json[]
    expect(waiting.some((item) => item.kind === 'INVOICE_TO_ISSUE' && item.record.id === G.party.id)).toBe(true)
    const drafted = await ok(P.finance, 'POST', '/invoicing/invoices/from-ddts', { ddtIds: [G.ddt.id] }, 201)
    expect(drafted.choice.docType).toBe('TD01')
    const deduction = (drafted.invoice.lines as Json[]).find((line) => line.kind === 'DEPOSIT_DEDUCTION')
    expect(deduction).toMatchObject({ depositInvoiceId: G.td02.id })
    expect(deduction!.netAmount).toBeLessThan(0)
    const checks = await ok(P.finance, 'GET', `/invoicing/invoices/${drafted.invoice.id}/checks`)
    expect(checks.problems.filter((problem: Json) => problem.severity !== 'WARNING')).toEqual([])
    await stepped(w, P.finance)
    const issued = await ok(P.finance, 'POST', `/invoicing/invoices/${drafted.invoice.id}/issue`, { version: drafted.invoice.version })
    expect(issued).toMatchObject({ invoice: { docType: 'TD01', status: 'ISSUED', xmlFileId: expect.any(String), pdfFileId: expect.any(String) }, filesPending: false })
    G.td01 = issued.invoice
    keep(G.td01.id)
    await drain(w)
  })

  it('33 both invoices go to SDI (FAKE): the scheduler’s poll and the worker record them DELIVERED', async () => {
    for (const invoice of [G.td02, G.td01]) {
      await stepped(w, P.finance)
      const sent = await ok(P.finance, 'POST', `/invoicing/invoices/${invoice.id}/sdi/send`, {})
      expect(sent.sdi.sends.at(-1).status).toBe('SENT')
    }
    await drain(w)
    // The scheduler's tick an hour later: both sends have waited long enough to be asked about.
    const tick = await runSdiPoll({ database: w.h.database, log: QUIET, clock: { now: () => new Date(Date.now() + 3_600_000) } })
    expect(tick).toMatchObject({ due: 2, failed: 0 })
    expect(await drain(w)).toContain('invoice.sdi_poll_due')
    for (const invoice of [G.td02, G.td01]) {
      expect((await ok(P.finance, 'GET', `/invoicing/invoices/${invoice.id}`)).invoice.status).toBe('DELIVERED')
    }
    expect(w.sdi.files.length).toBeGreaterThanOrEqual(2)
  })

  it('34 the customer pays the balance; the order is settled and the worker closes it', async () => {
    const settlementBefore = (await ok(P.finance, 'GET', `/invoicing/orders/${G.order.id}/settlement`)).settlement
    expect(settlementBefore.settled).toBe(false)
    const paid = await ok(P.finance, 'POST', '/payments', { companyId: companyA(), partyId: G.party.id, amount: G.td01.grossTotal, receivedOn: today(), externalRef: 'CRO-GOLDEN-0002', allocations: [{ invoiceId: G.td01.id }] }, 201)
    expect(paid.payment).toMatchObject({ unallocated: 0 })
    keep(paid.payment.id)
    const settlement = (await ok(P.finance, 'GET', `/invoicing/orders/${G.order.id}/settlement`)).settlement
    expect(settlement).toMatchObject({ settled: true, gaps: [], balanceDueAmount: 0 })
    expect(await drain(w)).toContain('order.fully_settled')
    expect((await ok(P.finance, 'GET', `/sales/orders/${G.order.id}`)).order.status).toBe('CLOSED')
  })

  // ---- 35 the end checks ---------------------------------------------------------------------------------------------------------

  it('35 nothing of this order waits on Home for anyone; every step left its audit rows and events', async () => {
    for (const who of Object.values(P)) {
      const items = ((await ok(who, 'GET', '/home/today?limit=200')).items ?? []) as Json[]
      expect(
        items.filter((item) => made.has(item.record.id)).map((item) => `${who.key}: ${item.kind} ${item.record.label}`),
        `Home of ${who.key}`,
      ).toEqual([])
      const waiting = ((await ok(who, 'GET', '/home/waiting-on-others')).items ?? []) as Json[]
      expect(waiting.filter((item) => made.has(item.record?.id)).map((item) => `${who.key}: ${item.kind}`)).toEqual([])
    }
    const ids = [...made]
    const actions = new Set((await admin<{ action: string }>(w, 'SELECT DISTINCT action FROM "AuditLog" WHERE "recordId" = ANY($1::uuid[])', [ids])).map((row) => row.action))
    const events = new Set((await admin<{ type: string }>(w, 'SELECT DISTINCT type FROM "OutboxEvent" WHERE subject = ANY($1::text[])', [ids])).map((row) => row.type))
    const missingActions = EXPECTED_ACTIONS.filter((action) => !actions.has(action))
    const missingEvents = EXPECTED_EVENTS.filter((type) => !events.has(type))
    expect({ missingActions, missingEvents }).toEqual({ missingActions: [], missingEvents: [] })
    // No handler of the worker needed a second try (two first issues of one work order share one start key now).
    expect(w.retried).toEqual([])
    const pending = await admin(w, `SELECT type FROM "OutboxEvent" WHERE "tenantId" = $1 AND status <> 'PUBLISHED'`, [w.tenant.id])
    expect(pending).toEqual([])
  })
})

/**
 * The EU variant (second scenario, same world, after the first order): a business customer in Germany whose VAT number
 * VIES (FAKE) confirms, so the jackets travel as an intra-EU supply of goods (DL 331/1993 art. 41: Natura N3.2, no
 * Italian VAT) and the deposit needs no deposit invoice (tax/deposit-rule DEPOSIT_EU_B2B_GOODS: the supply happens when
 * transport starts); the final TD01 carries the whole price. The same style, tablets, workers and printers make it.
 */
const EU = {} as Record<string, any>
const madeEu = new Set<string>()
const keepEu = (...ids: (string | undefined | null)[]) => ids.forEach((id) => id && madeEu.add(id))
const EU_ORDERS = 'einkauf@kunde-golden.example.com'
const EU_SIZES = { '52': 2 } as const

describe('the EU variant: a German business customer, VIES, N3.2, no deposit invoice', { timeout: 180_000 }, () => {
  it('E01 sales makes the customer and VIES (FAKE) confirms its VAT number', async () => {
    const { party } = await ok(
      P.sales,
      'POST',
      '/parties',
      {
        code: 'GF-EU-1',
        legalName: 'Kunde Golden GmbH (made up)',
        roles: ['CUSTOMER'],
        country: 'DE',
        language: 'en',
        taxIdentity: { country: 'DE', taxMode: 'EU_B2B', vatNumber: '100000017' },
        addresses: [{ kinds: ['REGISTERED', 'BILL_TO', 'SHIP_TO'], line1: 'Beispielstrasse 1', postalCode: '10115', city: 'Berlin', country: 'DE' }],
        contacts: [{ name: 'Clara Beispiel', email: EU_ORDERS, roles: ['ORDERS'] }],
      },
      201,
    )
    keepEu(party.id)
    const checked = await ok(P.sales, 'POST', `/parties/${party.id}/vies-checks`, { companyId: companyA() }, 201)
    expect(checked).toMatchObject({ check: { result: 'VALID' }, vies: { state: 'VALID' } })
    expect(w.vies.requests.at(-1)).toMatchObject({ countryCode: 'DE', vatNumber: '100000017' })
    EU.party = checked.party ?? party
  })

  it('E02 the quote is taxed as an intra-EU supply (N3.2) and needs no approval; sent and accepted by link', async () => {
    let { quote } = await ok(P.sales, 'POST', '/sales/quotes', { companyId: companyA(), partyId: EU.party.id, customerRef: 'PO-EU-77', promiseDate: addDays(today(), 60) }, 201)
    keepEu(quote.id)
    ;({ quote } = await ok(P.sales, 'POST', `/sales/quotes/${quote.id}/lines`, { version: quote.version, styleId: G.style.id, colourwayId: G.colourway.id, sizes: Object.entries(EU_SIZES).map(([size, quantity]) => ({ size, quantity })), unitPrice: '450' }, 201))
    expect(quote.current).toMatchObject({ taxMode: 'EU_B2B', vatAmount: 0 })
    expect(quote.approval.needed).toBe(false)
    const sent = await ok(P.sales, 'POST', `/sales/quotes/${quote.id}/send`, { version: quote.version })
    const customer = linkBrowser(w, linkTokenSentTo(w, EU_ORDERS))
    const accepted = await customer.send('POST', '/link/quote/accept', { versionId: sent.sent.versionId, typedName: 'Clara Beispiel', email: EU_ORDERS })
    // Goods to an EU business with a valid VIES number: the deposit is only a payment (no TD02).
    expect(accepted).toMatchObject({ state: 'ACCEPTED', deposit: { fiscalDocument: 'NONE', status: 'OPEN' } })
    EU.deposit = accepted.deposit
    const { orders } = await ok(P.sales, 'GET', `/sales/orders?partyId=${EU.party.id}`)
    EU.order = (await ok(P.sales, 'GET', `/sales/orders/${orders[0].id}`)).order
    keepEu(EU.deposit.id, EU.order.id, ...EU.order.lines.map((line: Json) => line.id))
    await drain(w)
  })

  it('E03 finance records the deposit: PAID, and no deposit invoice (the rule says why)', async () => {
    await stepped(w, P.finance)
    const received = await ok(P.finance, 'POST', '/payments/deposit-received', { depositRequestId: EU.deposit.id, amount: EU.deposit.amount, receivedOn: today(), externalRef: 'CRO-GOLDEN-EU-1' }, 201)
    expect(received).toMatchObject({ depositRequest: { status: 'PAID' }, depositInvoice: { required: false } })
    expect(received.depositInvoice.reason).toMatch(/DEPOSIT_EU_B2B_GOODS/)
    keepEu(received.payment.id)
    EU.depositPayment = received.payment
    await drain(w)
  })

  it('E04 made on the same floor: work order, cut, bundles, scans at every station, labels, inspected and released', async () => {
    const { workOrder } = await ok(P.planner, 'POST', '/production/work-orders', { lines: [{ salesOrderLineId: EU.order.lines[0].id }] }, 201)
    keepEu(workOrder.id)
    const check = await ok(P.planner, 'GET', `/production/work-orders/${workOrder.id}/release-check`)
    const blocked = (check.checks as Json[]).filter((entry) => entry.state === 'BLOCKED').map((entry) => entry.code)
    // The red leather left on the shelf is promised to the seeded work order: the planner releases with the reason.
    expect(blocked.filter((code) => code !== 'MATERIAL')).toEqual([])
    const wo = (await ok(P.planner, 'POST', `/production/work-orders/${workOrder.id}/release`, { version: workOrder.version, ...(blocked.length > 0 ? { materialOverride: { reason: 'The next red leather lot arrives before the seeded order is cut.' } } : {}) })).workOrder
    EU.wo = wo
    // The tablets' workers sign in again (their sessions may have gone idle), with their own PINs.
    for (const kind of ['CUTTING', 'SEWING', 'INSPECTION', 'PACKING'] as const) await ok(G.tablets[kind], 'POST', '/floor/sign-in', { badgeCode: G.workers[kind].badgeCode, pin: G.pins[kind] })
    const hide = (G.hides as Json[])[G.cutHides.length]!
    await ok(G.tablets.CUTTING, 'POST', `/inventory/picking/work-orders/${wo.id}/issue`, { code: hide.code }, 201)
    await ok(G.tablets.CUTTING, 'POST', `/production/cutting/work-orders/${wo.id}/cuts`, { clientEventId: `gf-eu-cut-${hide.code}`, code: hide.code, lines: wo.cells.map((cell: Json) => ({ workOrderSizeId: cell.id, sets: cell.quantity })), done: { remnant: null } }, 201)
    const { bundles } = await ok(G.tablets.CUTTING, 'POST', `/production/bundles/work-orders/${wo.id}/bundles`, { bundleSize: 10, printerId: id('print:printer:A1:LBL') }, 201)
    let n = 0
    for (const bundle of bundles as Json[]) {
      for (const op of (wo.spec.operations as Json[]).filter((entry) => entry.scanRequired).sort((a, b) => a.seq - b.seq)) {
        const clientScanId = `gf-eu-scan-${++n}-${bundle.code}`
        await ok(G.tablets[op.workCentreKind], 'POST', '/production/scans', { clientScanId, code: bundle.code, workOrderOperationId: op.id, good: bundle.quantity }, 201, { 'idempotency-key': clientScanId })
      }
    }
    await ok(G.tablets.PACKING, 'POST', `/production/serials/work-orders/${wo.id}/labels`, { printerId: G.garmentPrinter }, 201)
    await ok(P.planner, 'POST', `/production/work-orders/${wo.id}/complete`, {})
    const pieces = Object.values(EU_SIZES).reduce((sum, count) => sum + count, 0)
    const opened = (await ok(P.inspector, 'POST', '/quality/inspections', { workOrderId: wo.id, lotSize: pieces, sampleSize: pieces, inspectionLevel: 'II', aqlMajor: '2.5', aqlMinor: '4.0', acceptMajor: 0, acceptMinor: 1 }, 201)).inspection
    await stepped(w, P.inspector)
    await ok(P.inspector, 'POST', `/quality/inspections/${opened.id}/decide`, { version: opened.version, result: 'PASS', checklist: CHECKS.map((code) => ({ code, ok: true })) })
    for (const cell of wo.cells as Json[]) {
      await stepped(w, P.inspector)
      await ok(P.inspector, 'POST', '/quality/releases', { inspectionId: opened.id, workOrderSizeId: cell.id, quantity: cell.quantity }, 201)
    }
    await drain(w)
  })

  it('E05 shipped with its DDT and the carrier label; delivered', async () => {
    const ready = await ok(P.warehouse, 'GET', `/shipping/ready?salesOrderId=${EU.order.id}`)
    const cells = (ready.orders as Json[]).flatMap((order) => order.cells as Json[])
    let { shipment } = await ok(P.warehouse, 'POST', '/shipping/shipments', { salesOrderId: EU.order.id, lines: cells.map((cell) => ({ workOrderSizeId: cell.workOrderSizeId, quantity: cell.shippable })) }, 201)
    keepEu(shipment.id)
    const parcel = await ok(P.warehouse, 'POST', `/shipping/packing/${shipment.id}/parcels`, { grossWeightKg: '4.2' }, 201)
    for (const line of shipment.lines as Json[]) shipment = (await ok(P.warehouse, 'PUT', `/shipping/packing/${shipment.id}/lines/${line.id}/parcel`, { parcelId: parcel.parcelId })).shipment
    await ok(P.warehouse, 'POST', `/shipping/packing/${shipment.id}/pack`, {})
    EU.ddt = (await ok(P.warehouse, 'POST', `/shipping/shipments/${shipment.id}/ddt`, {}, 201)).ddt
    const bought = await ok(P.warehouse, 'POST', `/shipping/shipments/${shipment.id}/labels`, {}, 201)
    expect((await ok(P.warehouse, 'POST', `/shipping/shipments/${shipment.id}/ship`, {})).shipment.status).toBe('SHIPPED')
    await drain(w)
    const after = Math.max(Date.now(), w.h.clock.now().getTime())
    w.sendcloud.advance(bought.parcels[0].trackingNumber, 'DELIVERED', 'unused', new Date(after + 60_000))
    // The first order's step ran the scheduler's tick (one per tenant and hour, due in the 12th hour of silence): here
    // the worker's poll of this shipment runs directly, as its handler does on shipment.tracking_poll_due.
    expect(await pollShipment(processCarrier(), callerFor(w.h.database, systemContext(w.tenant.id, newId())), shipment.id)).toMatchObject({ moved: 'DELIVERED', failures: [] })
    await drain(w)
    expect((await ok(P.warehouse, 'GET', `/shipping/shipments/${shipment.id}/tracking`)).shipment.status).toBe('DELIVERED')
    EU.shipment = shipment
  })

  it('E06 the TD01 carries the whole price at N3.2 (no deposit deducted); SDI (FAKE) delivers it', async () => {
    const drafted = await ok(P.finance, 'POST', '/invoicing/invoices/from-ddts', { ddtIds: [EU.ddt.id] }, 201)
    expect(drafted.choice.docType).toBe('TD01')
    const goods = (drafted.invoice.lines as Json[]).filter((line) => line.kind === 'GOODS')
    expect(goods.every((line) => line.vatNature === 'N3.2' && line.vatLegalRef !== null)).toBe(true)
    expect((drafted.invoice.lines as Json[]).filter((line) => line.kind === 'DEPOSIT_DEDUCTION')).toEqual([])
    await stepped(w, P.finance)
    const issued = await ok(P.finance, 'POST', `/invoicing/invoices/${drafted.invoice.id}/issue`, { version: drafted.invoice.version })
    expect(issued.invoice).toMatchObject({ docType: 'TD01', status: 'ISSUED', vatTotal: 0 })
    EU.td01 = issued.invoice
    keepEu(EU.td01.id)
    await stepped(w, P.finance)
    await ok(P.finance, 'POST', `/invoicing/invoices/${EU.td01.id}/sdi/send`, {})
    await drain(w)
    await runSdiPoll({ database: w.h.database, log: QUIET, clock: { now: () => new Date(Date.now() + 3_600_000) } })
    await drain(w)
    expect((await ok(P.finance, 'GET', `/invoicing/invoices/${EU.td01.id}`)).invoice.status).toBe('DELIVERED')
  })

  it('E07 the deposit paid counts against the invoice; the balance settles the order and the worker closes it', async () => {
    const before = (await ok(P.finance, 'GET', `/invoicing/orders/${EU.order.id}/settlement`)).settlement
    expect(before.settled).toBe(false)
    const balance = EU.td01.grossTotal - EU.deposit.amount
    expect(before.balanceDueAmount).toBe(balance)
    const paid = await ok(P.finance, 'POST', '/payments', { companyId: companyA(), partyId: EU.party.id, amount: balance, receivedOn: today(), externalRef: 'CRO-GOLDEN-EU-2', allocations: [{ invoiceId: EU.td01.id }] }, 201)
    keepEu(paid.payment.id)
    expect((await ok(P.finance, 'GET', `/invoicing/orders/${EU.order.id}/settlement`)).settlement).toMatchObject({ settled: true, gaps: [], balanceDueAmount: 0 })
    await drain(w)
    expect((await ok(P.finance, 'GET', `/sales/orders/${EU.order.id}`)).order.status).toBe('CLOSED')
  })

  it('E08 nothing of the EU order waits on Home for anyone; no worker retry; nothing left in the outbox', async () => {
    for (const who of Object.values(P)) {
      const items = ((await ok(who, 'GET', '/home/today?limit=200')).items ?? []) as Json[]
      expect(items.filter((item) => madeEu.has(item.record.id)).map((item) => `${who.key}: ${item.kind} ${item.record.label}`), `Home of ${who.key}`).toEqual([])
    }
    expect(w.retried).toEqual([])
    expect(await admin(w, `SELECT type FROM "OutboxEvent" WHERE "tenantId" = $1 AND status <> 'PUBLISHED'`, [w.tenant.id])).toEqual([])
  })
})

/** One audit action per step at least (the flow's own records). */
const EXPECTED_ACTIONS = [
  'parties.create',
  'product.styles.create',
  'compliance.certificates.issue',
  'compliance.labels.activate',
  'product.bom.release',
  'product.compliance.issueDocument',
  'quotes.create',
  'quotes.approve',
  'quotes.send',
  'quotes.accept',
  'payments.sendDepositLink',
  'payments.depositPaid',
  'invoices.issue',
  'planning.run',
  'purchasing.send',
  'purchasing.confirmByLink',
  'inventory.receive',
  'quality.lots.release',
  'workorders.release',
  'inventory.issue',
  'production.cut',
  'production.makeBundles',
  'production.reportScan',
  'production.printGarmentLabels',
  'workorders.complete',
  'quality.inspection.decide',
  'quality.garments.release',
  'shipping.packShipment',
  'shipping.issueDdt',
  'shipping.buyLabels',
  'shipping.ship',
  'shipping.pollTracking',
  'shipping.trackingMove',
  'invoices.sdiStatus',
  'invoices.sdiArchive',
  'payments.record',
  'orders.follow',
]

/** One event per step at least (subject = one of the flow's records). */
const EXPECTED_EVENTS = [
  'party.created',
  'style.created',
  'style.revision_released',
  'compliance.label_template_activated',
  'style.compliance_document_issued',
  'quote.created',
  'quote.approval_decided',
  'quote.sent',
  'quote.accepted',
  'deposit_request.created',
  'sales_order.created',
  'deposit_request.link_sent',
  'payment.deposit_paid',
  'invoice.issued',
  'planning.run_finished',
  'purchase_order.sent',
  'purchase_order.confirmed',
  'inventory.receipt_posted',
  'lot.released',
  'workorder.released',
  'inventory.issued',
  'production.cut_logged',
  'production.bundle_created',
  'production.scan_recorded',
  'production.garment_labels_printed',
  'quality.inspection_decided',
  'quality.garments_released',
  'ddt.issued',
  'shipment.labels_bought',
  'shipment.status_changed',
  'invoice.sdi_status_changed',
  'payment.recorded',
  'order.fully_settled',
  'sales_order.status_changed',
]
