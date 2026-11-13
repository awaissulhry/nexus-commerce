import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import { businessDate } from '@nexus/factory-domain/core/time'
import { addDays } from '@nexus/factory-domain/planning/buy'
import type { ErrorReport } from '@nexus/factory-domain/observability/report'
import { FakeMailBucket } from '../../adapters/ses-inbound/fake'
import { inboundS3Store } from '../../adapters/ses-inbound/s3'
import { callerFor, command } from '../../core/command'
import { createErrorTracker, useErrorTracker } from '../../observability/tracker'
import { createEmailInRuntime, useEmailIn } from '../../platform/email-in/service'
import { rawMail, receivedNotificationBody } from '../../platform/email-in/testing'
import { useInbound } from '../../platform/inbound/providers'
import { fakeSignatureHeaders } from '../../platform/inbound/verifiers'
import type { EventHandler } from '../../platform/outbox/dispatch'
import { systemContext } from '../../platform/outbox/system'
import { standardReasonsForNewTenants } from '../../platform/reasons/standard'
import type { SearchIndexer } from '../../platform/search/indexer'
import { indexNewTenants } from '../../platform/search/indexing'
import { EXPORT_SOURCES } from '../../platform/exports/sources'
import { SECRET_PURPOSES, storeSecret } from '../../platform/secrets/store'
import { admin, announce, call, linkBrowser, linkTokenSentTo, ok, pdf, person, putBytes, QUIET, startWorld, stepped, type Person, type World } from '../testing/world'
import { assertEveryHandler, everyHandler, searchIndexers, settler } from '../daily/testing/day'

/**
 * The W2b-5 golden flow (B-W2b-359; design check I11): an inquiry to a confirmed order with options and a credit check, a promise
 * kept, planned work to a workshop, a PO approved and received by scan, a count and a transfer, a return and a safety report,
 * THROUGH THE HTTP ROUTES, each act by the person who does it, on the seeded factory. Sales, planning, buying and stock records
 * cross every module of W1 to W2b-4; the flow proves they agree:
 *
 *   A  the configurable jacket readied (its materials priced, a certificate, its garment label, its revision released); the
 *      brand's buyer writes (the mail comes in through SES, FAKE, and joins the brand's thread); sales makes an inquiry from the mail
 *      and its quote ("Make quote": the inquiry QUOTED, the quote knows its source).
 *   Q  the quote in depth: another request started from the season template (its terms, what it leaves out); the inquiry's quote
 *      filled by a size curve; the jacket's options checked by the rules (a refused pair said in the rule's words) and saved; the
 *      waterfall from the suggested price with a manual change and its reason (refused without one); the promise date from the
 *      calculator, used on the quote.
 *   C  the customer on hold warns on the quote (a warning, never a refusal), the hold released; the credit rule switched on and the
 *      limit lowered; version 1 sent, version 2 compared with it and sent; accepted by link: the order waits (PENDING_APPROVAL) with a
 *      credit HOLD; the asker may not approve, Finance does; the options and schedule carried; two orders from one version (a
 *      split); the confirmation PDF made and mailed; the deposit paid and the limit raised back.
 *   P  the plan: planned work orders, their materials from the multi-level explosion (the liner a sub-assembly, its wadding bought);
 *      a due date edited by hand (protected) kept by the next run; the planned order made real and released; its sewing to a
 *      workshop: refused while P2 is not approved for sewing, qualified by quality, the kit timed, the subcontract order drafted.
 *   B  the purchase order rule switched on; the protectors bought from the plan: the send waits (202), the buyer may not approve,
 *      Finance does, the worker sends it; confirmed by link, then a week later (a date change row); received in two deliveries
 *      within the tolerance; released by the inspector; put away by scan with the bin label; picked by the bin path; the rest
 *      from the second lot as a substitute with its yes (the Owner's rule; the asker may not approve).
 *   K  a count of the second lot: its line frozen (a move refused), counted short, the recount another person's, approved, applied.
 *   X  a STALE yes: a reorder's request, the order changed after it, the yes refused STALE.
 *   T  a transfer A1 → B1: shipped with its DDT (in transit), received.
 *   R  a return with a size exchange (the wrong-size fee dropped: the cause is ours; the exchange order at no price; COMPLETED); a
 *      service case that tells the customer at each move, its repair, the repair's estimate held until the yes, accepted.
 *   S  a product-safety report with an injury: its words in no list, read, search, export, case, register entry, event or mail;
 *      only the product-safety role opens them, each opening recorded.
 *   F  the W2b-4 follow-ups: an internal fit round's sample work order without an order line; production start counts production
 *      work orders only.
 *
 * World: the W1 golden world (../testing/world.ts: a throwaway PostgreSQL 17 database from the migrations, EVERY base seed plus
 * the W1 golden scenario, the real app with the real sign-in, every outside provider FAKE: mail in and out, carrier, SDI) and the
 * W2a day's worker (../daily/testing/day.ts: EVERY handler list of background.ts, run in-process by the real outbox relay). SQL
 * only reads ids and asserts: no step is made by SQL. No switched-off Owner switch is switched on but the approval rules the
 * steps name (credit, purchase orders, substitutes), each by the admin or the Owner through its route. The made-to-measure steps are not in
 * it (they wait for the Owner's word). No step depends on today's date: every day the flow types is a fixed day or a day the API
 * answered. Every name, address and figure is made up. Run with `node scripts/factory/golden-flow.mjs sales-depth`.
 */

let w: World
let handlers: readonly EventHandler[]
let indexers: readonly SearchIndexer[]
let settle: () => Promise<string[]>
type Json = Record<string, any>
type Role = 'owner' | 'admin' | 'sales' | 'finance' | 'planner' | 'buyer' | 'warehouse' | 'warehouse2' | 'manager' | 'inspector'
const P = {} as Record<Role, Person>
/** What the flow made, step by step. */
const G = {} as Record<string, any>
/** What the API reported as unexpected (a 500) during the flow: none at the end. */
const unexpected: ErrorReport[] = []
/** Every record the flow made: the end checks look for their audit rows. */
const made = new Set<string>()
const keep = (...ids: (string | undefined | null)[]) => ids.forEach((recordId) => recordId && made.add(recordId))
const id = (key: string) => w.id(key)
/** A seed row written with the seeds' firstId (ids that start with eight zeros). */
const first = (key: string) => `00000000${w.id(key).slice(8)}`
/** A seed row written with the seeds' lastId (ids that start with eight f's). */
const last = (key: string) => `ffffffff${w.id(key).slice(8)}`
/** A place's id by its label (a read: the routes take the label a scan gives). */
const placeOf = async (labelCode: string): Promise<string> => (await admin<{ id: string }>(w, `SELECT id FROM "Location" WHERE "tenantId" = $1 AND "labelCode" = $2`, [w.tenant.id, labelCode]))[0]!.id
const companyA = () => id('company:A')
const siteA1 = () => id('site:A1')
const pathsOf = (error: Json): string[] => ((error?.error?.issues ?? []) as Json[]).map((issue) => String(issue.path))
const refusalOf = (error: Json): string | undefined => pathsOf(error).find((path) => path.startsWith('refusal/'))
/** The FAKE SES receiving account of company A (seed/email-in.ts) and its bucket. */
const bucket = new FakeMailBucket()
const BUYER = 'buyer.p1@example.com'
const WEBHOOK = `made-up-golden-ses-hook-${newId()}`
/** The words of a made-up injury: only the product-safety role reads them, each opening recorded; no list, export or mail. */
const INJURY = 'Made-up injury words: a graze on the left elbow where the protector slid out of its pocket.'
const HAPPENED = 'Made-up: the rider slid at low speed on a track day; the left elbow protector moved out of its pocket.'

/** Every key of an answer, at any depth. */
function keysOf(value: unknown, into: string[] = []): string[] {
  if (Array.isArray(value)) for (const entry of value) keysOf(entry, into)
  else if (value && typeof value === 'object')
    for (const [key, entry] of Object.entries(value)) {
      into.push(key)
      keysOf(entry, into)
    }
  return into
}

// ---- the event types the flow must leave behind (Z1) --------------------------------------------------------------------------

const EVENTS = [
  // A: the mail and the inquiry
  'email.inbound_sorted',
  'inquiry.received',
  'inquiry.closed',
  // Q: the quote in depth
  'style.revision_released',
  'quote.created',
  'quote.lines_changed',
  'quote.updated',
  // C: holds, credit, the order
  'party.hold_placed',
  'party.hold_released',
  'approval.rule_changed',
  'credit_limit.changed',
  'quote.sent',
  'credit_check.recorded',
  'approval.requested',
  'approval.decided',
  'sales_order.created',
  'sales_order.status_changed',
  'sales_order.options_changed',
  'sales_order.split',
  'sales_order.confirmation_made',
  'sales_order.confirmation_sent',
  // P: planning
  'planning.run_finished',
  'planned_work_orders.planned',
  'planned_work_orders.edited',
  'planned_work_order.converted',
  'workorder.created',
  'workorder.released',
  'supplier_qualification.changed',
  'work_order_operation.outsourced',
  // B, K, X: buying, receiving, the warehouse
  'delivery_tolerance.changed',
  'purchase_order.approval_asked',
  'purchase_order.approved',
  'purchase_order.sent',
  'purchase_order.date_changed',
  'inventory.receipt_posted',
  'lot.released',
  'inventory.warehouse_task_changed',
  'inventory.count_scanned',
  'inventory.count_recorded',
  'inventory.issued',
  'inventory.substitution_changed',
  'approval.stale',
  'inventory.transfer_changed',
  // R: returns, repairs, service
  'return_fee_rule.changed',
  'return.policy_checked',
  'return.decided',
  'return.finished',
  'service_case.opened',
  'repair.created',
  'repair_estimate.sent',
  'repair_estimate.answered',
  // S: a safety report
  'safety_report.received',
  'accident_log.revised',
  'safety_report.filed',
  // F: the W2b-4 follow-ups
  'sample_round.requested',
  'sample_round.changed',
]

beforeAll(async () => {
  useErrorTracker(createErrorTracker({ sink: { kind: 'fake', send: (report) => void unexpected.push(report) }, source: 'api' }))
  w = await startWorld()
  // Mail in: the inbound ledger on the harness clock (SES's notifications are signed and dated by it) and the FAKE bucket SES
  // writes the raw mail into; the worker's handlers read it through the gateway.
  useInbound({ environment: 'test', secrets: w.h.secrets, clock: w.h.clock })
  useEmailIn(
    createEmailInRuntime({
      gateway: w.gateway,
      fake: bucket,
      s3: inboundS3Store({
        clientFor: () => {
          throw new Error('The golden flow never calls S3; the receiving account is FAKE.')
        },
      }),
      files: w.h.files,
    }),
  )
  // GAP (no route, as the portal suite's payment account): the seeded FAKE SES account of company A has no webhook secret and no
  // route sets one (Admin › Connections pauses and resumes only). Set as the system would, in one command with its audit row.
  await command(callerFor(w.h.database, systemContext(w.tenant.id, newId())), { name: 'golden.sesWebhookSecret', input: {} }, async (tools) => {
    const secret = await storeSecret(tools, w.h.secrets, { purpose: SECRET_PURPOSES.webhook, plaintext: WEBHOOK })
    await tools.tx.integrationAccount.update({ where: { id: id('email-in:account:ses') }, data: { webhookSecretId: secret.id }, select: { id: true } })
    tools.audit({ recordType: 'IntegrationAccount', recordId: id('email-in:account:ses'), after: { webhookSecret: 'set' } })
    return {}
  })
  indexers = await searchIndexers()
  handlers = everyHandler(indexers)
  settle = settler(w, handlers)
  for (const [key, role] of [
    ['owner', 'owner'],
    ['admin', 'admin'],
    ['sales', 'sales'],
    ['finance', 'finance'],
    ['planner', 'planner'],
    ['buyer', 'buyer'],
    ['warehouse', 'warehouse'],
    ['warehouse2', 'warehouse'],
    ['manager', 'production_manager'],
    ['inspector', 'quality_inspector'],
  ] as const) {
    P[key] = await person(w, key, role)
  }
}, 1_200_000)

afterAll(async () => {
  useEmailIn(undefined)
  useInbound(undefined)
  useErrorTracker(undefined)
  await w?.close()
}, 60_000)

/** The planner releases a work order: its checklist read first; a material short of stock is released over with a reason. */
async function release(who: Person, workOrderId: string): Promise<Json> {
  const { workOrder } = await ok(who, 'GET', `/production/work-orders/${workOrderId}`)
  const check = await ok(who, 'GET', `/production/work-orders/${workOrderId}/release-check`)
  const blockers = (check.blockers ?? []) as Json[]
  expect(blockers.filter((entry) => !String(entry.path).startsWith('materials/')), JSON.stringify(blockers)).toEqual([])
  const short = blockers.length > 0
  return (await ok(who, 'POST', `/production/work-orders/${workOrderId}/release`, { version: workOrder.version, ...(short ? { materialOverride: { reason: 'The leather is bought on the plan; it comes before cutting (made up).' } } : {}) })).workOrder
}

/** SES receives a mail: its raw bytes in the FAKE bucket, its "Received" notification through the inbound route, signed. */
async function mailIn(input: { from: string; subject: string; text: string }): Promise<string> {
  const sesMessageId = `ses${newId().replace(/-/g, '')}`
  const location = { bucket: 'factory-inbound-golden', key: `inbound/${sesMessageId}` }
  const to = ['orders@reply.company-a.golden.example.com']
  const messageId = `<${sesMessageId}@mail.example.com>`
  // The mail is dated by the server's clock (a minute ago), as SES dates it: the office's commands on it run on the server's
  // clock, while the harness clock runs ahead by 30 s per two-factor act (the signature is dated by the harness clock it checks).
  const at = new Date(Date.now() - 60_000)
  bucket.put(location, rawMail({ from: input.from, to, subject: input.subject, text: input.text, messageId, date: at }))
  const body = receivedNotificationBody({ snsMessageId: `sns-${sesMessageId}`, sesMessageId, ...location, from: input.from, to, subject: input.subject, messageId, at })
  const response = await w.h.app.inject({
    method: 'POST',
    url: `/inbound/ses/${w.tenant.id}/${id('email-in:account:ses')}`,
    payload: body,
    headers: { 'content-type': 'application/json', ...fakeSignatureHeaders(WEBHOOK, body, w.h.clock.now(), { id: `sns-${sesMessageId}`, type: 'ses.notification' }) },
  })
  expect(response.statusCode, response.body).toBe(200)
  return sesMessageId
}

describe('the W2b-5 golden flow: an inquiry to a confirmed order with options and a credit check, a promise kept, planned work to a workshop, a PO approved and received by scan, a count and a transfer, a return and a safety report, through the HTTP routes', { timeout: 180_000 }, () => {
  it('00 the world: the worker runs every handler list of background.ts; the seeds drain', async () => {
    assertEveryHandler()
    await standardReasonsForNewTenants({ database: w.h.database, log: QUIET })
    await indexNewTenants({ database: w.h.database, indexers, log: QUIET })
    await settle()
  })

  // ---- A: the mail and the inquiry -------------------------------------------------------------------------------------------

  it('A01 the configurable jacket readied: the buyer prices its contrast thread and its thermal liner, the inspector covers it by a certificate and names its garment label, the production manager makes its SKUs and releases its revision for black: a quote and an order line now take it', async () => {
    G.jkt05 = { id: id('options:style:JKT-05'), blk: id('options:colourway:JKT-05:BLK'), revision: id('options:revision:JKT-05:1') }
    G.jkt02 = { id: id('production:style:JKT-02'), red: id('production:colourway:JKT-02:RED') }
    // The cost sheet is complete only when every material has its standard purchase price (a quote cannot be sent before).
    for (const [key, price] of [['options:item:THR-530', '0.08'], ['options:item:CMP-500', '38.5']] as const) {
      const { material } = await ok(P.buyer, 'GET', `/product/materials/${id(key)}`)
      await ok(P.buyer, 'PUT', `/product/materials/${id(key)}/standard-cost`, { version: material.version, standardCost: price, currency: 'EUR', reason: 'The supplier’s price list of the season (made up).' })
    }
    const url = `/product/styles/${G.jkt05.id}/revisions/${G.jkt05.revision}`
    const version = async () => (await ok(P.manager, 'GET', `${url}/bom`)).bom.revision.version as number
    await ok(P.manager, 'POST', `/product/styles/${G.jkt05.id}/skus/generate`, {})
    // The EU type-examination certificate of the brand's jacket (its PDF, issued) covers the style.
    const created = (
      await ok(P.inspector, 'POST', '/compliance/certificates', {
        holderPartyId: id('party:P1'),
        standard: 'EN 17092-3:2020',
        ppeClass: 'AA',
        number: 'GF5-CERT-0001',
        notifiedBodyName: 'Golden Notified Body (made up)',
        notifiedBodyNumber: '0000',
        modelReference: 'SEED-JKT-05',
        validFrom: '2026-01-15',
        validTo: '2031-01-14',
      }, 201)
    ).certificate
    keep(created.id)
    const certificate = pdf('EU type-examination certificate GF5-CERT-0001')
    const announced = await ok(P.inspector, 'POST', `/compliance/certificates/${created.id}/pdf`, announce('certificate.pdf', certificate), 201)
    await putBytes(w, announced, certificate)
    const attached = await ok(P.inspector, 'POST', `/compliance/certificates/${created.id}/pdf/${announced.file.id}/complete`)
    const issued = (await ok(P.inspector, 'POST', `/compliance/certificates/${created.id}/issue`, { version: attached.certificate.version })).certificate
    await ok(P.inspector, 'POST', `/compliance/certificates/${created.id}/coverage`, { version: issued.version, styleId: G.jkt05.id }, 201)
    // The garment label (it, en), activated and named on the draft revision.
    const { template } = await ok(P.inspector, 'POST', '/compliance/labels', {
      styleId: G.jkt05.id,
      languages: ['it', 'en'],
      composition: [
        { part: 'shell', fibres: [{ fibre: 'leather (not a textile)', percent: '100' }] },
        { part: 'lining', fibres: [{ fibre: 'polyester', percent: '100' }] },
      ],
      animalOriginPhrase: true,
      care: [{ symbol: 'wash-not' }, { symbol: 'bleach-not' }, { symbol: 'iron-not' }, { symbol: 'dryclean-professional' }],
      layout: { fields: ['ceMark', 'pictogram', 'standard', 'model', 'size', 'bodyMeasures', 'batchOrSerial', 'maker'] },
    }, 201)
    keep(template.id)
    const active = (await ok(P.inspector, 'POST', `/compliance/labels/${template.id}/activate`, { version: template.version })).template
    await ok(P.inspector, 'PUT', `${url}/label`, { labelTemplateId: active.id, version: await version() })
    const gate = (await ok(P.manager, 'GET', `${url}/release-gate`)).gate
    expect(gate.releasable, JSON.stringify(gate)).toBe(true)
    await ok(P.manager, 'PUT', `${url}/release-scope`, { version: await version(), colourwayIds: [G.jkt05.blk], sizes: [] })
    const released = (await ok(P.manager, 'POST', `${url}/release`, { version: await version(), changeNote: 'Golden W2b-5: the configurable touring jacket, black' })).bom
    expect(released.revision.status).toBe('RELEASED')
    await settle()
  })

  it('A02 the brand’s buyer writes: SES (FAKE) tells the inbound route, the worker reads the mail and joins it to the brand’s own thread', async () => {
    const sesMessageId = await mailIn({
      from: `"Seed Buyer One" <${BUYER}>`,
      subject: 'Richiesta preventivo giacche touring',
      text: 'Buongiorno,\nci servono 40 giacche touring configurabili (nere, con imbottitura e nome) e 8 giacche rosse.\nGrazie',
    })
    await settle()
    const [mail] = await admin(w, `SELECT id, status::text AS status, "senderPartyId" FROM "InboundEmail" WHERE "sesMessageId" = $1`, [sesMessageId])
    // A known contact writing without a reply address: the brand's own thread when DMARC passes.
    expect(mail).toMatchObject({ status: 'MATCHED', senderPartyId: id('party:P1') })
    G.mail = mail
    keep(mail!.id)
  })

  it('A03 sales makes an inquiry from the mail (the brand found by its contact) with two lines by size, and its quote in one command: the inquiry QUOTED, the quote knows where it came from', async () => {
    const draft = await ok(P.sales, 'GET', `/sales/inquiries/from-mail/${G.mail.id}`)
    expect(draft).toMatchObject({ inquiry: null, party: { id: id('party:P1') }, matchedBy: 'CONTACT', refusal: null })
    const [mailRow] = await admin<{ version: number }>(w, `SELECT version FROM "InboundEmail" WHERE id = $1`, [G.mail.id])
    const version = mailRow!.version
    let { inquiry } = await ok(
      P.sales,
      'POST',
      `/sales/inquiries/from-mail/${G.mail.id}`,
      {
        version,
        companyId: companyA(),
        wantedDate: '2030-04-30',
        lines: [
          { styleId: G.jkt05.id, colourwayId: G.jkt05.blk, sizes: { '50': 10, '52': 20, '54': 10 } },
          { styleId: G.jkt02.id, colourwayId: G.jkt02.red, sizes: { '50': 2, '52': 4, '54': 2 } },
        ],
      },
      201,
    )
    expect(inquiry).toMatchObject({ source: 'MAIL', party: { id: id('party:P1') }, mail: { id: G.mail.id } })
    keep(inquiry.id)
    // REFUSAL: one inquiry per mail.
    const [again] = await admin(w, `SELECT version FROM "InboundEmail" WHERE id = $1`, [G.mail.id])
    expect(refusalOf(await ok(P.sales, 'POST', `/sales/inquiries/from-mail/${G.mail.id}`, { version: again!.version }, 409))).toBe('refusal/MAIL_TAKEN')
    inquiry = (await ok(P.sales, 'POST', `/sales/inquiries/${inquiry.id}/assign`, { version: inquiry.version, assigneeId: P.sales.id })).inquiry
    const quoted = await ok(P.sales, 'POST', `/sales/inquiries/${inquiry.id}/quote`, { version: inquiry.version, customerRef: 'PO-GOLDEN-W2B5-1' }, 201)
    expect(quoted.leftOut, JSON.stringify(quoted.leftOut)).toEqual([])
    expect(quoted.inquiry).toMatchObject({ status: 'QUOTED', quote: { id: quoted.quote.id } })
    G.inquiry = quoted.inquiry
    G.quote = (await ok(P.sales, 'GET', `/sales/quotes/${quoted.quote.id}`)).quote
    keep(G.quote.id)
    expect((await ok(P.sales, 'GET', `/sales/inquiries/source?quoteId=${G.quote.id}`)).inquiry).toMatchObject({ id: inquiry.id, status: 'QUOTED' })
    await settle()
  })

  // ---- Q: the quote in depth ---------------------------------------------------------------------------------------------------

  it('Q01 another request of the brand starts from the season template: its terms on the version, its lines in their sections, what it leaves out said in words', async () => {
    const started = await ok(P.sales, 'POST', `/sales/quote-templates/${first('sales-pricing:template:SEASON')}/quote`, { companyId: companyA(), partyId: id('party:P1'), customerRef: 'PO-GOLDEN-W2B5-SEASON' }, 201)
    keep(started.quote.id)
    const terms = await ok(P.sales, 'GET', `/sales/quotes/${started.quote.id}/terms`)
    expect(terms).toMatchObject({ incoterm: 'EXW', shipComplete: true })
    // The configurable jacket's template line names no colourway and no pieces: left out until the person picks them.
    expect(started.leftOut.length).toBeGreaterThan(0)
    G.templateQuote = started.quote
  })

  it('Q02 the inquiry’s quote: the configurable jacket’s line filled by the small-run size curve (40 pieces: 10/20/10)', async () => {
    const line = (G.quote.lines as Json[]).find((entry) => entry.styleId === G.jkt05.id)!
    G.lines = { jkt05: line.id, jkt02: (G.quote.lines as Json[]).find((entry) => entry.styleId === G.jkt02.id)!.id }
    const curves = (await ok(P.sales, 'GET', `/sales/size-curves?companyId=${companyA()}`)).curves as Json[]
    const small = curves.find((curve) => curve.name === 'Seed small run')!
    const preview = await ok(P.sales, 'POST', `/sales/quotes/${G.quote.id}/lines/fill`, { version: G.quote.version, curveId: small.id, lines: [{ lineId: line.id, pieces: 40 }], preview: true })
    expect(preview.source).toMatchObject({ kind: 'CURVE', id: small.id })
    const filled = await ok(P.sales, 'POST', `/sales/quotes/${G.quote.id}/lines/fill`, { version: G.quote.version, curveId: small.id, lines: [{ lineId: line.id, pieces: 40 }] })
    G.quote = filled.quote ?? (await ok(P.sales, 'GET', `/sales/quotes/${G.quote.id}`)).quote
    const sizes = ((G.quote.lines as Json[]).find((entry) => entry.id === line.id)!.sizes as Json[]).map((size) => [size.size, size.quantity])
    expect(sizes).toEqual([['50', 10], ['52', 20], ['54', 10]])
  })

  it('Q03 the jacket’s options: full perforation with the liner refused in the rule’s words (nothing written); the liner, front perforation, the name and the standard armour saved, the line priced again', async () => {
    const base = `/sales/quotes/${G.quote.id}/lines/${G.lines.jkt05}`
    const view = await ok(P.sales, 'GET', `${base}/configurator`)
    expect(view.may.configure).toBe(true)
    const V = { linerYes: first('options:value:LINER:YES'), perfFront: id('options:value:PERF:FRONT'), perfFull: id('options:value:PERF:FULL'), name: id('options:value:NAME:NAME'), armourStd: id('options:value:ARMOUR:STD') }
    const clash = await ok(P.sales, 'POST', `${base}/configurator/check`, { picks: [{ valueId: V.perfFull }, { valueId: V.linerYes }] })
    expect(clash.ok).toBe(false)
    expect(clash.blocks[0]).toMatchObject({ code: 'EXCLUDES', severity: 'BLOCK' })
    // REFUSAL: the write checks the rule again, in its words.
    const refused = await ok(P.sales, 'PUT', `${base}/options`, { version: G.quote.version, picks: [{ valueId: V.perfFull }, { valueId: V.linerYes }] }, 409)
    expect(refused.error.message).not.toBe('')
    // Front perforation too (GAP named in the notes: a work order whose cells choose none of an option-only routing step's values
    // is refused by the database at its release with a 500; with the step chosen every step applies).
    const saved = await ok(P.sales, 'PUT', `${base}/options`, { version: G.quote.version, picks: [{ valueId: V.linerYes }, { valueId: V.perfFront }, { valueId: V.name, text: 'ROSSI' }, { valueId: V.armourStd }] })
    G.quote = saved.quote
    const chosen = (await ok(P.sales, 'GET', `${base}/configurator`)).chosen as Json[]
    expect(chosen.map((row) => row.valueId).sort()).toEqual([V.linerYes, V.perfFront, V.name, V.armourStd].sort())
    G.optionValues = V
  })

  it('Q04 the waterfall: the jacket priced from its suggested price (cost and the floor’s margin), its options, a 5 % discount and a manual change to a round net with its reason (refused without one); each step from its source', async () => {
    const base = `/sales/quotes/${G.quote.id}/lines/${G.lines.jkt05}`
    // REFUSAL: a manual change without its reason code.
    const noReason = await call(P.sales.browser, 'PUT', `${base}/price`, { version: G.quote.version, start: 'SUGGESTED', discount: { pct: '5', reasonCode: 'VOLUME' }, net: { unitPrice: '480' } })
    expect(noReason.status).toBe(400)
    const pricing0 = await ok(P.sales, 'GET', `/sales/quotes/${G.quote.id}/pricing`)
    const before = (pricing0.lines as Json[]).find((entry) => entry.id === G.lines.jkt05 || entry.lineId === G.lines.jkt05)!
    expect(before.suggested.unitPrice, JSON.stringify(before.suggested)).toEqual(expect.any(String))
    const priced = await ok(P.sales, 'PUT', `${base}/price`, { version: G.quote.version, start: 'SUGGESTED', discount: { pct: '5', reasonCode: 'VOLUME' }, net: { unitPrice: '480', reasonCode: 'COMPETITION', note: 'Matched a competing offer for the brand (made up).' } })
    G.quote = priced.quote
    const kinds = (priced.line.steps as Json[]).map((step) => step.kind)
    expect(kinds[0]).toBe('SUGGESTED')
    expect(kinds).toEqual(expect.arrayContaining(['OPTION', 'DISCOUNT', 'MANUAL', 'NET']))
    const pricing = await ok(P.sales, 'GET', `/sales/quotes/${G.quote.id}/pricing`)
    const row = (pricing.lines as Json[]).find((entry) => entry.id === G.lines.jkt05 || entry.lineId === G.lines.jkt05)!
    expect(row).toMatchObject({ unitPrice: '480', adjustmentReason: 'COMPETITION' })
    expect(row.why.sentence).toEqual(expect.any(String))
    await settle()
  })

  it('Q05 the promise date from the calculator: every line asked at once on the plant A1, the answer used on the quote', async () => {
    const asked = await ok(P.sales, 'GET', `/planning/promise/quotes/${G.quote.id}?siteId=${siteA1()}`)
    expect(asked.mayUse).toBe(true)
    expect(asked.promiseDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    G.quote = (await ok(P.sales, 'PATCH', `/sales/quotes/${G.quote.id}`, { version: G.quote.version, promiseDate: asked.promiseDate })).quote
    expect(G.quote.current.promiseDate ?? G.quote.promiseDate).toBe(asked.promiseDate)
    G.promiseDate = asked.promiseDate
    await settle()
  })

  // ---- C: the hold, the credit limit, the order ---------------------------------------------------------------------------------

  it('C01 the customer on hold warns: finance holds the brand for a quality dispute, the quote says so (a warning, never a refusal); the hold released with its words', async () => {
    const placed = (await ok(P.finance, 'POST', `/parties/${id('party:P1')}/holds`, { companyId: companyA(), reason: 'QUALITY_DISPUTE', words: 'The brand disputes a delivery of last season (made up).' }, 201)).holds
    expect(placed.onHold).toBe(true)
    const hold = (placed.holds as Json[]).find((entry) => entry.inForce && entry.reason === 'QUALITY_DISPUTE')!
    keep(hold.id)
    const warnings = await ok(P.sales, 'GET', `/sales/quotes/${G.quote.id}/warnings`)
    const onHold = (warnings.warnings ?? warnings.rows ?? warnings.findings) as Json[]
    expect(onHold.find((entry) => entry.code === 'ACCOUNT_ON_HOLD'), JSON.stringify(warnings)).toMatchObject({ severity: 'WARNING' })
    const released = (await ok(P.finance, 'POST', `/parties/${id('party:P1')}/holds/${hold.id}/release`, { version: hold.version, words: 'Settled with the brand (made up).' })).holds
    expect((released.holds as Json[]).find((entry) => entry.id === hold.id)).toMatchObject({ inForce: false, releaseWords: 'Settled with the brand (made up).' })
    const after = await ok(P.sales, 'GET', `/sales/quotes/${G.quote.id}/warnings`)
    expect(JSON.stringify(after)).not.toContain('ACCOUNT_ON_HOLD')
    await settle()
  })

  it('C02 the credit rule switched on by the admin (orders over the limit wait for Finance); finance lowers the brand’s limit to 10,000.00 with its reason', async () => {
    const rules = (await ok(P.admin, 'GET', '/approvals/rules?kind=CREDIT_OVERRIDE')).rules as Json[]
    const rule = rules.find((entry) => entry.id === id('approvals:rule:CREDIT'))!
    expect(rule.active).toBe(false)
    await ok(P.admin, 'PUT', `/approvals/rules/${rule.id}`, { version: rule.version, active: true })
    const limits = (await ok(P.finance, 'GET', `/sales/credit/limits?companyId=${companyA()}`)).rows as Json[]
    const row = limits.find((entry) => entry.party.id === id('party:P1'))!
    const changed = await ok(P.finance, 'PUT', `/sales/credit/limits/${id('party:P1')}/${companyA()}`, { version: row.version, amount: 1_000_000, currency: 'EUR', reason: 'Lowered after the dispute until the brand pays (made up).' })
    expect(changed.row).toMatchObject({ limit: 1_000_000 })
    await settle()
  })

  it('C03 sales sends the quote: a frozen version, its PDF, the accept link mailed to the brand’s buyer', async () => {
    G.quote = (await ok(P.sales, 'GET', `/sales/quotes/${G.quote.id}`)).quote
    if (G.quote.approval.needed) {
      G.quote = (await ok(P.sales, 'POST', `/sales/quotes/${G.quote.id}/approval`, { version: G.quote.version, note: 'Launch of the configurable jacket (made up).' })).quote
      await ok(P.sales, 'POST', `/sales/quotes/${G.quote.id}/approval/approve`, { version: G.quote.version }, 403)
      G.quote = (await ok(P.finance, 'POST', `/sales/quotes/${G.quote.id}/approval/approve`, { version: G.quote.version, note: 'Approved for the launch (made up).' })).quote
    }
    const check = await ok(P.sales, 'GET', `/sales/quotes/${G.quote.id}/send-check`)
    expect(check.checks.filter((entry: Json) => entry.severity === 'BLOCKS'), JSON.stringify(check.checks)).toEqual([])
    const sent = await ok(P.sales, 'POST', `/sales/quotes/${G.quote.id}/send`, { version: G.quote.version })
    expect(sent).toMatchObject({ quote: { status: 'SENT' }, delivery: 'sent' })
    G.quote = sent.quote
    G.recipient = sent.sent.to
    G.v1 = sent.sent.versionId
    keep(sent.sent.versionId, sent.sent.documentFileId)
    await settle()
  })

  it('C04 the brand asks for more red jackets: sales revises the quote, version 2 compared with version 1 (the red line’s sizes), sent again', async () => {
    G.quote = (await ok(P.sales, 'POST', `/sales/quotes/${G.quote.id}/revise`, { version: G.quote.version, changeNote: 'The brand asks 12 red jackets (made up).' })).quote
    expect(G.quote.currentRevision).toBe(2)
    const red = (G.quote.lines as Json[]).find((line) => line.styleId === G.jkt02.id)!
    G.quote = (await ok(P.sales, 'PATCH', `/sales/quotes/${G.quote.id}/lines/${red.id}`, { version: G.quote.version, sizes: [{ size: '50', quantity: 3 }, { size: '52', quantity: 6 }, { size: '54', quantity: 3 }] })).quote
    const compared = await ok(P.sales, 'GET', `/sales/quotes/${G.quote.id}/versions/compare?from=1&to=2`)
    expect((compared.differs as Json[]).find((entry) => entry.section === 'lines'), JSON.stringify(compared.differs)).toMatchObject({ changed: 1 })
    expect(compared.before).toMatchObject({ label: expect.stringContaining('1') })
    expect(JSON.stringify(compared.sections)).toContain('52')
    // Version 2 keeps the configured jacket's options (revise carries them by line).
    const jacket = (G.quote.lines as Json[]).find((line) => line.styleId === G.jkt05.id)!
    G.lines = { jkt05: jacket.id, jkt02: red.id }
    const chosen = (await ok(P.sales, 'GET', `/sales/quotes/${G.quote.id}/lines/${jacket.id}/configurator`)).chosen as Json[]
    expect(chosen.map((row) => row.valueId).sort()).toEqual([G.optionValues.linerYes, G.optionValues.perfFront, G.optionValues.name, G.optionValues.armourStd].sort())
    if (G.quote.approval.needed) {
      G.quote = (await ok(P.sales, 'POST', `/sales/quotes/${G.quote.id}/approval`, { version: G.quote.version, note: 'More red jackets (made up).' })).quote
      G.quote = (await ok(P.finance, 'POST', `/sales/quotes/${G.quote.id}/approval/approve`, { version: G.quote.version })).quote
    }
    const sent = await ok(P.sales, 'POST', `/sales/quotes/${G.quote.id}/send`, { version: G.quote.version })
    G.quote = sent.quote
    G.v2 = sent.sent.versionId
    keep(sent.sent.versionId)
    await settle()
  })

  it('C05 the brand accepts version 2 by link: the order is made, and over the credit limit it waits (PENDING_APPROVAL) with a HOLD nobody asked for yet', async () => {
    const customer = linkBrowser(w, linkTokenSentTo(w, G.recipient))
    const page = await customer.send('GET', '/link/quote')
    expect({ state: page.state, versionId: page.quote?.versionId }, JSON.stringify(page).slice(0, 600)).toEqual({ state: 'OPEN', versionId: G.v2 })
    const accepted = await customer.send('POST', '/link/quote/accept', { versionId: G.v2, typedName: 'Seed Buyer One', email: G.recipient })
    expect(accepted.state).toBe('ACCEPTED')
    G.deposit = accepted.deposit
    await settle()
    const { orders } = await ok(P.sales, 'GET', `/sales/orders?partyId=${id('party:P1')}&limit=200`)
    const order = (orders as Json[]).find((entry) => entry.quote?.versionId === G.v2)
    const [acceptance] = await admin(w, `SELECT action, after FROM "AuditLog" WHERE "recordType" = 'Quote' AND "recordId" = $1 ORDER BY at DESC, id DESC LIMIT 1`, [G.quote.id])
    expect(order, JSON.stringify(acceptance)).toBeDefined()
    G.order = (await ok(P.sales, 'GET', `/sales/orders/${order!.id}`)).order
    keep(G.order.id)
    expect(G.order.status).toBe('PENDING_APPROVAL')
    const credit = await ok(P.sales, 'GET', `/sales/credit/records/SalesOrder/${G.order.id}`)
    expect(credit.customers[0]).toMatchObject({ wouldBe: 'HOLD', may: { ask: true } })
    G.hold = credit.customers[0].checks[0]
    expect(G.hold).toMatchObject({ result: 'HOLD' })
  })

  it('C06 sales asks for a yes; the asker cannot give it (refused, naming who can); finance approves: the order goes on (CONFIRMED) and the worker carries the options and the delivery schedule onto it', async () => {
    const { taskId } = await ok(P.sales, 'POST', `/sales/credit/checks/${G.hold.id}/ask`, { note: 'A good brand; the dispute is settled (made up).' }, 201)
    keep(taskId)
    const { task } = await ok(P.sales, 'GET', `/approvals/tasks/${taskId}`)
    expect(task.approve.allowed).toBe(false)
    // REFUSAL: nobody approves their own request.
    expect(refusalOf(await ok(P.sales, 'POST', `/approvals/tasks/${taskId}/approve`, { version: task.version }, 403))).toBe('refusal/OWN_REQUEST')
    await ok(P.finance, 'POST', `/approvals/tasks/${taskId}/approve`, { version: task.version, comment: 'The brand pays on time (made up).' })
    await settle()
    G.order = (await ok(P.sales, 'GET', `/sales/orders/${G.order.id}`)).order
    expect(G.order.status).toBe('CONFIRMED')
    const jacket = (G.order.lines as Json[]).find((line) => line.styleId === G.jkt05.id)!
    const chosen = (await ok(P.sales, 'GET', `/sales/orders/${G.order.id}/lines/${jacket.id}/configurator`)).chosen as Json[]
    expect(chosen.map((row) => row.valueId).sort()).toEqual([G.optionValues.linerYes, G.optionValues.perfFront, G.optionValues.name, G.optionValues.armourStd].sort())
    G.orderLines = { jkt05: jacket.id, jkt02: (G.order.lines as Json[]).find((line) => line.styleId === G.jkt02.id)!.id }
  })

  it('C07 two orders from one version: sales splits the red jackets into an order of their own; each names the other from the same quote version', async () => {
    const split = await ok(P.sales, 'POST', `/sales/orders/${G.order.id}/split`, { version: G.order.version, reason: 'The red jackets ship on their own (made up).', parts: [{ lines: [{ lineId: G.orderLines.jkt02 }] }] }, 201)
    const other = (split.orders as Json[]).find((entry) => entry.id !== G.order.id)!
    G.order2 = other
    keep(other.id)
    const depth = await ok(P.sales, 'GET', `/sales/orders/${G.order.id}/depth`)
    expect((depth.sameQuote as Json[]).map((entry) => entry.id ?? entry.orderId)).toContain(other.id)
    G.order = (await ok(P.sales, 'GET', `/sales/orders/${G.order.id}`)).order
    expect((G.order.lines as Json[]).map((line) => line.styleId)).toEqual([G.jkt05.id])
    await settle()
  })

  it('C08 the order confirmation: its PDF made (the same contents give the same version back) and mailed to the brand', async () => {
    const madeOne = await ok(P.sales, 'POST', `/sales/orders/${G.order.id}/confirmation`, { language: 'it' }, 201)
    expect(madeOne).toMatchObject({ made: true, fileId: expect.any(String) })
    keep(madeOne.fileId)
    const again = await ok(P.sales, 'POST', `/sales/orders/${G.order.id}/confirmation`, { language: 'it' }, 201)
    expect(again.made).toBe(false)
    const sent = await ok(P.sales, 'POST', `/sales/orders/${G.order.id}/confirmation/send`, {}, 201)
    expect(JSON.stringify(sent)).not.toMatch(/#token=/)
    const state = (await ok(P.sales, 'GET', `/sales/orders/${G.order.id}/confirmation`)).confirmation
    expect(state, JSON.stringify(state)).toMatchObject({ upToDate: true, sentVersion: expect.any(Number) })
    await settle()
  })

  it('C09 the brand pays its deposit (finance records it: the request PAID); finance raises the limit back with its reason, so the work of the order is not held at its release', async () => {
    expect(G.deposit, 'the acceptance asked a deposit').toBeTruthy()
    await stepped(w, P.finance)
    const received = await ok(P.finance, 'POST', '/payments/deposit-received', { depositRequestId: G.deposit.id, amount: G.deposit.amount, receivedOn: businessDate(new Date()), externalRef: 'CRO-GOLDEN-W2B5-1' }, 201)
    expect(received.depositRequest.status).toBe('PAID')
    keep(received.payment.id)
    const limits = (await ok(P.finance, 'GET', `/sales/credit/limits?companyId=${companyA()}`)).rows as Json[]
    const row = limits.find((entry) => entry.party.id === id('party:P1'))!
    await ok(P.finance, 'PUT', `/sales/credit/limits/${id('party:P1')}/${companyA()}`, { version: row.version, amount: 100_000_000, currency: 'EUR', reason: 'The brand agreed a payment plan (made up).' })
    const credit = await ok(P.finance, 'GET', `/sales/credit/records/SalesOrder/${G.order.id}`)
    expect(credit.customers[0].findings).not.toContain('OVER_LIMIT')
    await settle()
  })

  // ---- P: planning ---------------------------------------------------------------------------------------------------------------

  it('P01 the planner runs the plan for A1: the confirmed orders become planned work orders, their materials from the multi-level explosion (the liner’s own materials, the name’s thread)', async () => {
    const { run } = await ok(P.planner, 'POST', '/planning/runs', { siteId: siteA1(), note: 'Golden W2b-5' }, 201)
    expect(run.status).toBe('DONE')
    keep(run.id)
    const planned = await ok(P.planner, 'GET', `/planning/planned-orders?siteId=${siteA1()}`)
    const forOrder = (orderId: string) => (planned.plannedOrders as Json[]).filter((row) => (row.demand as Json[]).some((entry) => entry.orderId === orderId))
    G.planned = { jkt05: forOrder(G.order.id)[0], jkt02: forOrder(G.order2.id)[0] }
    expect(G.planned.jkt05).toMatchObject({ kind: 'MAKE', status: 'PLANNED', held: null })
    expect((G.planned.jkt05.sizes as Json[]).map((size) => [size.size, size.quantity])).toEqual([['50', 10], ['52', 20], ['54', 10]])
    expect(G.planned.jkt02).toMatchObject({ kind: 'MAKE', status: 'PLANNED' })
    // The multi-level explosion: the liner (a sub-assembly, chosen by the option) is made, its wadding bought; the name's thread too.
    const lines = (await ok(P.planner, 'GET', `/planning/runs/latest?siteId=${siteA1()}&shortOnly=true`)).lines as Json[]
    const lineOf = (code: string) => lines.find((line) => line.item?.code === code)
    const sourcesOf = (code: string) => ((lineOf(code)?.sources ?? []) as Json[]).map((source) => source.orderNumber)
    expect(lineOf('SEED-CMP-500')).toMatchObject({ action: 'MAKE' })
    expect(sourcesOf('SEED-CMP-500')).toContain(G.order.number)
    expect(lineOf('SEED-TXT-520')).toMatchObject({ action: 'BUY' })
    expect(sourcesOf('SEED-TXT-520')).toContain(G.order.number)
    expect(sourcesOf('SEED-THR-530')).toContain(G.order.number)
    // The red jackets have no liner: their order is no source of the wadding.
    expect(sourcesOf('SEED-TXT-520')).not.toContain(G.order2.number)
    G.protectorLine = lineOf('SEED-PRO-300')
    expect(G.protectorLine).toMatchObject({ action: 'BUY', supplier: { id: id('party:P2') } })
    expect(sourcesOf('SEED-PRO-300')).toContain(G.order.number)
  })

  it('P02 the planner moves the jacket’s due date by hand (protected); the next run keeps it and rewrites only what is not protected', async () => {
    const row = G.planned.jkt05
    const due = addDays(row.dueDate, 7)
    const edited = await ok(P.planner, 'PATCH', `/planning/planned-orders/${row.id}`, { version: row.version, dueDate: due, note: 'The brand asked a week later (made up).' })
    expect(edited.plannedOrder).toMatchObject({ dueDate: due, protectedFields: ['dueDate'] })
    const { run } = await ok(P.planner, 'POST', '/planning/runs', { siteId: siteA1(), note: 'Golden W2b-5, again' }, 201)
    keep(run.id)
    const kept = (await ok(P.planner, 'GET', `/planning/planned-orders/${row.id}`)).plannedOrder
    expect(kept).toMatchObject({ dueDate: due, protectedFields: ['dueDate'], status: 'PLANNED' })
    expect(kept.plan.dueDate ?? kept.plan?.dueDate).toBe(row.dueDate)
    G.planned.jkt05 = kept
    await settle()
  })

  it('P03 the planner makes the jacket’s planned order real: a work order for 40 jackets, released (the leather short, released over with the reason); the order follows', async () => {
    const preview = await ok(P.planner, 'POST', '/planning/planned-orders/convert', { rows: [{ id: G.planned.jkt05.id, version: G.planned.jkt05.version }], preview: true })
    expect(preview.results[0]).toMatchObject({ ok: true, kind: 'MAKE' })
    const made = await ok(P.planner, 'POST', '/planning/planned-orders/convert', { rows: [{ id: G.planned.jkt05.id, version: G.planned.jkt05.version }] })
    expect(made).toMatchObject({ made: 1, held: 0 })
    const workOrderId = made.results[0].workOrder.id
    keep(workOrderId)
    G.wo = await release(P.planner, workOrderId)
    expect(G.wo.status).toBe('RELEASED')
    expect((await ok(P.planner, 'GET', `/planning/planned-orders?siteId=${siteA1()}&status=CONVERTED`)).plannedOrders.map((row: Json) => row.id)).toContain(G.planned.jkt05.id)
    await settle()
  })

  it('P04 the work order’s sewing to a workshop: P2 not approved for sewing is refused in words; quality qualifies it; the kit timed before the start; the subcontract order drafted with that kit time', async () => {
    const base = `/planning/work-orders/${G.wo.id}`
    let workshops = await ok(P.buyer, 'GET', `${base}/workshops`)
    const sewing = (workshops.operations as Json[]).find((operation) => operation.workCentreKind === 'SEWING')!
    expect((workshops.workshops as Json[]).find((entry) => entry.id === id('party:P2'))).toMatchObject({ offered: false })
    // REFUSAL: only an approved workshop gets work.
    const refused = await ok(P.buyer, 'POST', `${base}/operations/${sewing.id}/outside`, { version: sewing.version, partyId: id('party:P2') }, 409)
    expect(pathsOf(refused)).toContain('refusal/NOT_QUALIFIED')
    const vault = await ok(P.inspector, 'GET', `/purchasing/suppliers/${id('party:P2')}/qualifications`)
    const evidence = (vault.suggestions.files as Json[]).slice(0, 1).map((file) => ({ recordType: file.recordType, recordId: file.recordId }))
    expect(evidence.length).toBe(1)
    const asked = await ok(P.inspector, 'POST', `/purchasing/suppliers/${id('party:P2')}/qualifications`, { companyId: companyA(), workCentreKinds: ['SEWING'], evidence }, 201)
    const qualification = (asked.qualifications as Json[]).find((entry) => entry.id === asked.qualificationId)!
    keep(qualification.id)
    await ok(P.inspector, 'POST', `/purchasing/suppliers/${id('party:P2')}/qualifications/${qualification.id}/decide`, { version: qualification.version, decision: 'APPROVED' })
    workshops = await ok(P.buyer, 'GET', `${base}/workshops`)
    expect((workshops.workshops as Json[]).find((entry) => entry.id === id('party:P2'))).toMatchObject({ offered: true })
    const timing = await ok(P.buyer, 'GET', `${base}/kit-timing?partyId=${id('party:P2')}&operationIds=${sewing.id}&start=2030-03-01`)
    expect(timing).toMatchObject({ start: '2030-03-01', startSource: 'GIVEN', late: false })
    expect(timing.kitShipOn < timing.start).toBe(true)
    const operation = (workshops.operations as Json[]).find((entry) => entry.id === sewing.id)!
    const sent = await ok(P.buyer, 'POST', `${base}/operations/${sewing.id}/outside`, { version: operation.version, partyId: id('party:P2'), start: '2030-03-01' })
    expect(sent.operation).toMatchObject({ outsourced: true, subcontractOrderId: sent.order.id })
    expect(sent.order).toMatchObject({ status: 'DRAFT' })
    keep(sent.order.id)
    G.subcontract = sent.order
    const [order] = await admin(w, `SELECT "kitDueAt" FROM "SubcontractOrder" WHERE id = $1`, [sent.order.id])
    expect(new Date(order!.kitDueAt).toISOString()).toBe(new Date(timing.kitDueAt).toISOString())
    await settle()
  })

  // ---- B: buying, receiving, the warehouse -----------------------------------------------------------------------------------------

  it('B01 the Owner switches on the purchase order rule (over 100.00 → Finance); the buyer keeps the protectors of P2 within 5 % either way', async () => {
    const rules = (await ok(P.owner, 'GET', '/approvals/rules?kind=PURCHASE_ORDER')).rules as Json[]
    const rule = rules.find((entry) => entry.id === first('approvals:rule:PO'))!
    expect(rule.active).toBe(false)
    const switched = await ok(P.owner, 'PUT', `/approvals/rules/${rule.id}`, { version: rule.version, condition: { combinator: 'and', rows: [{ id: 'r1', field: 'orderValue', operator: 'gt', value: '100' }] }, active: true })
    expect(switched.rule.active).toBe(true)
    // The seeds keep a tolerance of P2's protectors already (none over): the buyer widens it to 5 % either way.
    const tolerances = (await ok(P.buyer, 'GET', `/purchasing/tolerances?companyId=${companyA()}&supplierId=${id('party:P2')}&itemId=${id('product:item:protector')}&status=ACTIVE`)).tolerances as Json[]
    const row = tolerances.find((entry) => (entry.item?.id ?? entry.itemId) === id('product:item:protector'))!
    const widened = await ok(P.buyer, 'PATCH', `/purchasing/tolerances/${row.id}`, { version: row.version, overPct: '5', underPct: '5', whenBeyond: 'BLOCK', note: 'Protectors come in boxes of a dozen (made up).' })
    expect(widened.tolerance).toMatchObject({ overPct: '5', underPct: '5' })
    await settle()
  })

  it('B02 the buyer orders the plan’s protectors from P2 (the liner’s jacket among their sources) and sends the PO: over the rule it waits for a yes (202); the buyer may not give it, Finance does, and the worker sends it with its link', async () => {
    const lines = (await ok(P.buyer, 'GET', `/planning/runs/latest?siteId=${siteA1()}&shortOnly=true`)).lines as Json[]
    const protector = lines.find((line) => line.item?.code === 'SEED-PRO-300')!
    const drafted = await ok(P.buyer, 'POST', '/purchasing/from-plan', { lines: [{ id: protector.id, version: protector.version }], into: [{ supplierId: id('party:P2'), purchaseOrderId: null }] })
    let order = (await ok(P.buyer, 'GET', `/purchasing/orders/${drafted.orders[0].id}`)).order
    keep(order.id)
    const line = (order.lines as Json[])[0]!
    order = (await ok(P.buyer, 'PATCH', `/purchasing/orders/${order.id}/lines/${line.id}`, { version: order.version, needDate: '2030-02-15' })).order
    const sent = await ok(P.buyer, 'POST', `/purchasing/orders/${order.id}/send`, { version: order.version }, 202)
    expect(sent.order.status).toBe('PENDING_APPROVAL')
    const taskId = sent.approval.taskId
    keep(taskId)
    const { task } = await ok(P.buyer, 'GET', `/approvals/tasks/${taskId}`)
    // REFUSAL: the buyer asked; another person approves.
    expect(refusalOf(await ok(P.buyer, 'POST', `/approvals/tasks/${taskId}/approve`, { version: task.version }, 403))).toBe('refusal/OWN_REQUEST')
    await ok(P.finance, 'POST', `/approvals/tasks/${taskId}/approve`, { version: task.version, comment: 'Within the season budget (made up).' })
    await settle()
    G.po = (await ok(P.buyer, 'GET', `/purchasing/orders/${order.id}`)).order
    expect(G.po.status).toBe('SENT')
    const approval = await ok(P.buyer, 'GET', `/purchasing/orders/${order.id}/approval`)
    expect(approval.state ?? approval.approval?.state, JSON.stringify(approval).slice(0, 400)).toBe('SENT_WITH_YES')
  })

  it('B03 the supplier confirms by link as asked; then its order desk says a week later: the buyer records the date with its reason (a date change row), the line confirmed later than asked', async () => {
    const supplier = linkBrowser(w, linkTokenSentTo(w, 'orders.p2@example.com'))
    const page = await supplier.send('GET', '/link/purchase-order')
    expect(page).toMatchObject({ order: { id: G.po.id }, canAnswer: true })
    expect(keysOf(page).filter((key) => /price|cost|amount/i.test(key))).toEqual([])
    const answered = await supplier.send('POST', '/link/purchase-order/confirm', { version: page.order.version, mode: 'ALL_AS_ASKED', typedName: 'Seed Order Desk', supplierRef: 'OC-GOLDEN-W2B5-1' })
    expect(answered.outcome).toBe('CONFIRMED')
    await settle()
    let order = (await ok(P.buyer, 'GET', `/purchasing/orders/${G.po.id}`)).order
    const line = (order.lines as Json[])[0]!
    const moved = await ok(P.buyer, 'POST', `/purchasing/orders/${G.po.id}/lines/${line.id}/supplier-date`, { version: order.version, date: '2030-02-22', source: 'SUPPLIER', reason: 'The protectors’ maker ships a week later (made up).', supplierContactName: 'Seed Order Desk' })
    expect(moved.dateChangeIds.length).toBe(1)
    const depth = moved.depth ?? (await ok(P.buyer, 'GET', `/purchasing/orders/${G.po.id}/depth`))
    expect(depth.dateChanges.length).toBe(1)
    expect(depth.lines[0].confirmedLaterBy).toBe(7)
    order = (await ok(P.buyer, 'GET', `/purchasing/orders/${G.po.id}`)).order
    G.po = order
    await settle()
  })

  it('B04 the warehouse receives the protectors in two deliveries, the second a little over: within the 5 %, the order RECEIVED; each delivery its own lot', async () => {
    const line = (G.po.lines as Json[])[0]!
    const ordered = Number(line.confirmedQuantity ?? line.quantity)
    const firstPart = Math.floor(ordered / 2)
    const secondPart = ordered - firstPart + Math.max(1, Math.floor(ordered * 0.025))
    const receive = async (ddt: string, lot: string, quantity: number) =>
      (await ok(P.warehouse, 'POST', '/inventory/receipts', { purchaseOrderId: G.po.id, supplierDdtNumber: ddt, supplierDdtDate: businessDate(new Date()), lines: [{ purchaseOrderLineId: line.id, lots: [{ supplierLotRef: lot, quantity: String(quantity) }] }] }, 201)).receipt
    const one = await receive('DDT-GOLDEN-W2B5-1', 'PRO-GF5-1', firstPart)
    expect(one.purchaseOrder.status).toBe('PARTLY_RECEIVED')
    const two = await receive('DDT-GOLDEN-W2B5-2', 'PRO-GF5-2', secondPart)
    expect(two.purchaseOrder.status).toBe('RECEIVED')
    const lotOf = (receipt: Json) => (receipt.lines as Json[])[0]!.lots[0]
    G.lots = [lotOf(one), lotOf(two)]
    G.receipts = [one, two]
    G.lotQuantities = [firstPart, secondPart]
    keep(one.id, two.id, ...G.lots.map((lot: Json) => lot.id))
    for (const lot of G.lots) expect(lot).toMatchObject({ qualityStatus: 'QUARANTINE' })
    await settle()
  })

  it('B05 the inspector (not the receiver) releases both lots with the protectors’ PPE certificate', async () => {
    for (const [index, lot] of (G.lots as Json[]).entries()) {
      const base = `/quality/lots/${lot.id}`
      const certificate = pdf(`EN 1621-1 certificate of the protector lot PRO-GF5-${index + 1}`)
      const upload = await ok(P.inspector, 'POST', `${base}/documents/upload`, announce(`ppe-${index + 1}.pdf`, certificate), 201)
      await putBytes(w, upload, certificate)
      await ok(P.inspector, 'POST', `${base}/documents`, { fileId: upload.file.id, kind: 'PPE_CERTIFICATE', validTo: '2031-01-14' }, 201)
      const check = await ok(P.inspector, 'GET', `${base}/release-check`)
      expect(check.checklist).toMatchObject({ ready: true })
      const released = (await ok(P.inspector, 'POST', `${base}/release`, { version: check.lot.version, confirmCode: check.lot.code })).lot
      expect(released.qualityStatus).toBe('RELEASED')
      G.lots[index] = { ...lot, code: check.lot.code }
    }
    await settle()
  })

  it('B06 put away by scan: the warehouse scans each lot at the dock, the bin label confirms where it goes; the put-away tasks are done', async () => {
    for (const lot of G.lots as Json[]) {
      const scanned = await ok(P.warehouse, 'GET', `/inventory/putaway/scan?code=${encodeURIComponent(lot.code)}`)
      const place = scanned.suggestion?.location?.labelCode ?? 'BIN-A1-PF-01'
      // REFUSAL: a label of no place.
      expect((await call(P.warehouse.browser, 'POST', '/inventory/putaway', { code: lot.code, placeCode: 'BIN-NOWHERE-99' })).status).toBe(400)
      const put = await ok(P.warehouse, 'POST', '/inventory/putaway', { code: lot.code, placeCode: place }, 201)
      expect(JSON.stringify(put)).toContain(lot.code)
      lot.placeCode = place
    }
    await settle()
    const tasks = await ok(P.warehouse, 'GET', `/inventory/tasks?siteId=${siteA1()}&kind=PUT_AWAY&status=ALL`)
    const ofReceipts = (tasks.tasks as Json[]).filter((task) => (G.receipts as Json[]).some((receipt) => receipt.id === task.source?.id))
    expect(ofReceipts.length).toBeGreaterThan(0)
    expect(ofReceipts.every((task) => task.status === 'DONE'), JSON.stringify(ofReceipts.map((task) => task.status))).toBe(true)
  })

  // ---- K: a count with frozen lines ------------------------------------------------------------------------------------------------

  it('K01 a count of the second lot, its line frozen: a move of the lot is refused in words; the warehouse counts short, the rule asks a recount that its counter may not do; a colleague recounts; approved by the Owner (who counted nothing), applied', async () => {
    const lot = G.lots[1]
    const bin = await placeOf(lot.placeCode)
    const { count } = await ok(P.warehouse, 'POST', '/inventory/stock-counts', { siteId: siteA1(), kind: 'CYCLE', lotId: lot.id, start: true, freeze: true }, 201)
    expect(count).toMatchObject({ status: 'COUNTING', freezeMoves: true })
    keep(count.id)
    // REFUSAL: a frozen line holds its moves.
    const frozen = await ok(P.warehouse, 'POST', '/inventory/bin-moves', { code: lot.code, placeCode: 'BIN-A1-BULK-01', quantity: '1' }, 409)
    expect(pathsOf(frozen)).toContain('warehouse/COUNT_FROZEN')
    const expected = G.lotQuantities[1] as number
    await ok(P.warehouse, 'POST', `/inventory/stock-counts/${count.id}/scans`, { placeCode: lot.placeCode, code: lot.code, quantity: String(expected - 10) }, 201)
    const finished = await ok(P.warehouse, 'POST', `/inventory/stock-counts/${count.id}/bins/${bin}/finish`, {})
    expect(finished.recountsAsked.length).toBe(1)
    // REFUSAL: the recount is another person's.
    expect(pathsOf(await ok(P.warehouse, 'POST', `/inventory/stock-counts/${count.id}/scans`, { placeCode: lot.placeCode, code: lot.code, quantity: String(expected) }, 409))).toContain('refusal/OWN_RECOUNT')
    await ok(P.warehouse2, 'POST', `/inventory/stock-counts/${count.id}/scans`, { placeCode: lot.placeCode, code: lot.code, quantity: String(expected) }, 201)
    await ok(P.warehouse2, 'POST', `/inventory/stock-counts/${count.id}/bins/${bin}/finish`, {})
    let record = (await ok(P.warehouse, 'GET', `/inventory/stock-counts/${count.id}`)).count
    const line = ((await ok(P.warehouse, 'GET', `/inventory/stock-counts/${count.id}/lines`)).lines as Json[])[0]!
    expect({ counted: Number(line.counted), status: line.status }, JSON.stringify(line)).toEqual({ counted: expected - 10, status: 'COUNTED' })
    expect(Number(line.recount.quantity)).toBe(expected)
    expect(Number(line.final)).toBe(expected)
    record = (await ok(P.warehouse, 'POST', `/inventory/stock-counts/${count.id}/submit`, { version: record.version })).count
    // Approved by someone who counted nothing (the counter rule): the Owner.
    record = (await ok(P.owner, 'POST', `/inventory/stock-counts/${count.id}/approve`, { version: record.version })).count
    const applied = await ok(P.warehouse, 'POST', `/inventory/stock-counts/${count.id}/apply`, { version: record.version })
    expect(applied.moves ?? []).toEqual([])
    expect((await ok(P.warehouse, 'GET', `/inventory/stock-counts/frozen?siteId=${siteA1()}&locationId=${bin}`)).lines).toEqual([])
    await settle()
  })

  // ---- B: picking by bin, a substitute with its yes ---------------------------------------------------------------------------------

  it('B07 the pick list of the jacket’s work order walks the store by bin path; the warehouse takes the first lot at its stop', async () => {
    const walk = await ok(P.warehouse, 'GET', `/inventory/pick-lists/work-orders/${G.wo.id}`)
    const stops = walk.stops as Json[]
    expect(stops.map((stop) => stop.turn)).toEqual(stops.map((_, index) => index + 1))
    const stop = stops.find((entry) => entry.lotCode === G.lots[0].code)
    expect(stop, JSON.stringify(stops.map((entry) => [entry.turn, entry.itemCode, entry.lotCode, entry.location?.code, entry.source]))).toMatchObject({ location: { labelCode: G.lots[0].placeCode }, quality: 'RELEASED' })
    const issued = await ok(P.warehouse, 'POST', `/inventory/picking/work-orders/${G.wo.id}/issue`, { code: G.lots[0].code, quantity: stop!.quantity, fromLocationId: stop!.location.id }, 201)
    expect(Number(issued.issue.baseQuantity)).toBe(Number(stop!.quantity))
    G.issuedFromFirst = Number(stop!.quantity)
    await settle()
  })

  it('B08 the rest of the protectors from the second lot as a substitute: refused while no rule names an approver; the Owner’s rule on, the warehouse asks, may not approve it, the production manager does; issued with its own move', async () => {
    const bomLineId = last('options:bom:JKT-05:1:30')
    const options = await ok(P.warehouse, 'GET', `/inventory/substitutions/options?workOrderId=${G.wo.id}&bomLineId=${bomLineId}`)
    const own = (options.choices as Json[]).find((choice) => choice.kind === 'OWN_MATERIAL')!
    expect(own).toMatchObject({ needsPerson: true, mayAsk: false })
    const open = Number(options.line.toIssue)
    expect(open).toBeGreaterThan(0)
    const body = { workOrderId: G.wo.id, bomLineId, toItemId: id('product:item:protector'), toLotId: G.lots[1].id, quantity: String(open), reason: 'The first lot is used up (made up).' }
    expect(pathsOf(await ok(P.warehouse, 'POST', '/inventory/substitutions', body, 409))).toEqual(['refusal/NO_APPROVER'])
    const [role] = await admin<{ id: string }>(w, `SELECT id FROM "Role" WHERE "tenantId" = $1 AND key = 'production_manager'`, [w.tenant.id])
    const { rule } = await ok(P.owner, 'POST', '/approvals/rules', { kind: 'MATERIAL_SUBSTITUTION', companyId: companyA(), name: 'PPE substitutes (golden, made up)', condition: { combinator: 'and', rows: [{ field: 'ppeComponent', operator: 'eq', value: 'YES' }] }, approver: { roleId: role!.id } }, 201)
    expect(rule.active).toBe(false)
    await ok(P.owner, 'PUT', `/approvals/rules/${rule.id}`, { version: rule.version, active: true })
    const asked = (await ok(P.warehouse, 'POST', '/inventory/substitutions', body, 201)).substitution
    expect(asked).toMatchObject({ status: 'WAITING', approval: { status: 'PENDING' } })
    keep(asked.id)
    const taskId = asked.approval.taskId
    const { task } = await ok(P.warehouse, 'GET', `/approvals/tasks/${taskId}`)
    expect(refusalOf(await ok(P.warehouse, 'POST', `/approvals/tasks/${taskId}/approve`, { version: task.version }, 403))).toBe('refusal/OWN_REQUEST')
    expect(pathsOf(await ok(P.warehouse, 'POST', `/inventory/substitutions/${asked.id}/issue`, {}, 409))).toEqual(['refusal/NOT_APPROVED'])
    await ok(P.manager, 'POST', `/approvals/tasks/${taskId}/approve`, { version: task.version, comment: 'The same protector, another lot (made up).' })
    const approved = (await ok(P.warehouse, 'GET', `/inventory/substitutions/${asked.id}`)).substitution
    expect(approved.status).toBe('APPROVED')
    const issued = await ok(P.warehouse, 'POST', `/inventory/substitutions/${asked.id}/issue`, { version: approved.version }, 201)
    expect(issued.substitution.status).toBe('ISSUED')
    G.substituted = open
    await settle()
  })

  // ---- X: a STALE approval ---------------------------------------------------------------------------------------------------------

  it('X01 a STALE yes: the buyer reorders the protectors and asks for a yes on the draft; the order changes after the request; Finance’s yes is refused STALE in words and nothing is sent', async () => {
    const copied = await ok(P.buyer, 'POST', `/purchasing/orders/${G.po.id}/duplicate`, { needDate: '2030-03-15' }, 201)
    keep(copied.order.id)
    const asked = await ok(P.buyer, 'POST', '/approvals/requests', { kind: 'PURCHASE_ORDER', recordId: copied.order.id, note: 'The next season’s protectors (made up).' }, 201)
    expect(asked.asked).toBe(true)
    const taskId = asked.task.id
    let order = (await ok(P.buyer, 'GET', `/purchasing/orders/${copied.order.id}`)).order
    const line = (order.lines as Json[])[0]!
    order = (await ok(P.buyer, 'PATCH', `/purchasing/orders/${order.id}/lines/${line.id}`, { version: order.version, quantity: String(Number(line.quantity) + 12) })).order
    const { task } = await ok(P.finance, 'GET', `/approvals/tasks/${taskId}`)
    expect(refusalOf(await ok(P.finance, 'POST', `/approvals/tasks/${taskId}/approve`, { version: task.version }, 409))).toBe('refusal/STALE')
    expect((await ok(P.finance, 'GET', `/approvals/tasks/${taskId}`)).task.status).toBe('STALE')
    expect((await ok(P.buyer, 'GET', `/purchasing/orders/${order.id}`)).order.status).toBe('DRAFT')
    await settle()
  })

  // ---- T: a transfer -------------------------------------------------------------------------------------------------------------

  it('T01 a transfer of protectors from A1 to B1: shipped with its DDT onto the transit place, in transit, received at B1', async () => {
    const lot = G.lots[1]
    let transfer = (await ok(P.warehouse, 'POST', '/inventory/transfer-orders', { fromSiteId: siteA1(), toSiteId: id('site:B1'), toLocationId: (await admin<{ id: string }>(w, `SELECT l.id FROM "Location" l JOIN "Site" s ON s.id = l."siteId" WHERE l."tenantId" = $1 AND l.code = 'B1-STORE'`, [w.tenant.id]))[0]!.id, note: 'Protectors for the second plant (made up).' }, 201)).transfer
    keep(transfer.id)
    transfer = (await ok(P.warehouse, 'POST', `/inventory/transfer-orders/${transfer.id}/lines`, { version: transfer.version, itemId: id('product:item:protector'), lotId: lot.id, fromLocationId: await placeOf(lot.placeCode), quantity: '3' }, 201)).transfer
    const shipped = await ok(P.warehouse, 'POST', `/inventory/transfer-orders/${transfer.id}/ship`, { version: transfer.version, reason: 'WORK_ON_ACCOUNT', transportBy: 'SENDER', packages: 1, grossWeightKg: '2.5' })
    transfer = shipped.transfer
    expect(transfer.status).toBe('SHIPPED')
    expect(transfer.ddt?.number ?? transfer.ddtNumber).toEqual(expect.any(String))
    const inTransit = await ok(P.warehouse, 'GET', '/inventory/transfer-orders?tile=IN_TRANSIT')
    expect((inTransit.rows as Json[]).map((row) => row.id)).toContain(transfer.id)
    const received = await ok(P.warehouse, 'POST', `/inventory/transfer-orders/${transfer.id}/receive`, { version: transfer.version, lines: [{ lineId: transfer.lines[0].id, quantity: '3' }] })
    expect(received.transfer.status).toBe('RECEIVED')
    await settle()
  })

  // ---- R: a return, a repair, a service case ---------------------------------------------------------------------------------------

  it('R01 a return with a size exchange: the brand sends back a red 52 we packed by mistake; the wrong-size fee is dropped because the cause is ours; the exchange order in 54 at no price; the return closed COMPLETED', async () => {
    const rule = await ok(P.finance, 'POST', '/sales/returns/fee-rules', { companyId: companyA(), channel: 'B2B', name: 'Wrong size restocking (made up)', reasonCodes: ['WRONG_SIZE'], kind: 'PERCENT', percent: '10', sequence: 5 }, 201)
    keep(rule.rule.id)
    let rma = (await ok(P.sales, 'POST', '/sales/returns', { companyId: companyA(), partyId: id('party:P1'), siteId: siteA1(), lines: [{ salesOrderLineId: id('production:sales-order:SO-0002:20'), size: '52', quantity: 1, reasonCode: 'WRONG_SIZE' }] }, 201)).return
    keep(rma.id)
    const bound = await ok(P.sales, 'POST', `/sales/returns/${rma.id}/policy`, { version: rma.version, reason: 'We packed the wrong size: taken back whatever the window (made up).' })
    expect(bound.return.policy.named).toBeTruthy()
    rma = (await ok(P.sales, 'GET', `/sales/returns/${rma.id}`)).return
    const lineId = rma.lines[0].id
    rma = (await ok(P.warehouse, 'POST', `/sales/returns/${rma.id}/receipts`, { version: rma.version, parcels: 1, parcelCondition: 'INTACT', lines: [{ lineId, quantity: 1 }] }, 201)).return
    await ok(P.warehouse, 'POST', `/sales/returns/${rma.id}/grades`, { version: rma.version, lines: [{ lineId, grade: 'NEW', cause: 'OUR_DEFECT' }] })
    // The wrong-size rule would withhold 10 % of a credit; the cause is ours, so it is dropped (a size exchange credits nothing).
    const preview = await ok(P.sales, 'POST', `/sales/returns/${rma.id}/fees/preview`, { lines: [{ lineId, disposition: 'CREDIT_ONLY' }] })
    expect(preview.lines[0].fee, JSON.stringify(preview)).toMatchObject({ ruleId: rule.rule.id, amount: 0, dropped: 'OUR_CAUSE' })
    expect(preview.lines[0].creditAfter).toBe(preview.lines[0].creditBefore)
    rma = (await ok(P.sales, 'GET', `/sales/returns/${rma.id}`)).return
    // REFUSAL: a size exchange names another size than the one that came back.
    expect((await ok(P.sales, 'POST', `/sales/returns/${rma.id}/decisions`, { version: rma.version, lines: [{ lineId, disposition: 'SIZE_EXCHANGE', goodsOutcome: 'QUARANTINE', exchangeSize: '52' }] }, 400)).error.message).toMatch(/52/)
    const decided = await ok(P.sales, 'POST', `/sales/returns/${rma.id}/decisions`, { version: rma.version, lines: [{ lineId, disposition: 'SIZE_EXCHANGE', goodsOutcome: 'QUARANTINE', exchangeSize: '54' }] })
    expect(decided.return.lines[0]).toMatchObject({ disposition: 'SIZE_EXCHANGE', followUp: 'REPLACEMENT_ORDER' })
    const replacement = await ok(P.sales, 'POST', `/sales/returns/${rma.id}/replacement-order`, { version: decided.return.version }, 201)
    keep(replacement.order.id)
    const order = (await ok(P.sales, 'GET', `/sales/orders/${replacement.order.id}`)).order
    expect(order.lines[0].sizes.map((size: Json) => [size.size, size.quantity])).toEqual([['54', 1]])
    expect(Number(order.lines[0].unitPrice)).toBe(0)
    const outcomes = (await ok(P.sales, 'GET', `/sales/returns/${rma.id}/outcomes`)).return
    expect(outcomes.finish.suggested).toBe('COMPLETED')
    await ok(P.sales, 'POST', `/sales/returns/${rma.id}/finish`, { version: outcomes.version, finishReason: 'COMPLETED' })
    await settle()
  })

  it('R02 a service case that tells the customer: the brand phones about a torn seam; the case opened with the customer told at each move, its repair made from it', async () => {
    const opened = await ok(P.sales, 'POST', '/sales/service/cases', { companyId: companyA(), kind: 'REPAIR', channel: 'PHONE', partyId: id('party:P1'), contactId: id('party-contact:P1:buyer'), problem: 'Made-up: the shoulder seam of a jacket opened after a month.', customerWants: 'REPAIR', notifyCustomer: true }, 201)
    G.case = opened.case
    keep(G.case.id)
    const repair = await ok(P.sales, 'POST', `/sales/service/cases/${G.case.id}/repair`, { version: G.case.version, workWanted: 'Re-sew the shoulder seam (made up).', received: { inboundDdtNumber: 'DDT-P1-GF5-9' } }, 201)
    G.repair = repair.repair
    keep(G.repair.id)
    G.case = repair.case
    const before = w.h.ses.mails.length
    const moved = await ok(P.sales, 'POST', `/sales/service/cases/${G.case.id}/status`, { version: G.case.version, to: 'OPEN', message: 'We have your jacket; the repair estimate follows (made up).' })
    expect(moved.notified).toMatchObject({ sent: true, to: BUYER })
    G.case = moved.case
    await settle()
    expect(w.h.ses.mails.slice(before).some((mail) => mail.to.includes(BUYER))).toBe(true)
  })

  it('R03 the repair quote: drafted, priced, sent; the repair may not be approved while it waits (refused in words); the brand’s yes recorded by the office: the repair APPROVED; the case told again', async () => {
    let view = await ok(P.sales, 'POST', `/sales/repairs/${G.repair.id}/estimates`, { customerNote: 'Return transport included (made up).' }, 201)
    const draft = view.estimates[0]
    view = await ok(P.sales, 'POST', `/sales/repairs/estimates/${draft.id}/lines`, { version: draft.version, kind: 'LABOUR', description: 'Re-sew the shoulder seam', quantity: '1', minutes: 40, unitPrice: '35.00' }, 201)
    view = await ok(P.sales, 'POST', `/sales/repairs/estimates/${draft.id}/send`, { version: view.estimates[0].version })
    expect(view.estimates[0].status).toBe('SENT')
    const repair = (await ok(P.sales, 'GET', `/sales/repairs/${G.repair.id}`)).repair
    // REFUSAL: W2a's stage route waits for the customer's answer.
    const early = await ok(P.sales, 'POST', `/sales/repairs/${G.repair.id}/stage`, { version: repair.version, to: 'APPROVED', note: 'Approved (made up).' }, 409)
    expect(early.error.message).toMatch(/waits for the customer's answer/)
    const sent = view.estimates[0]
    const answered = await ok(P.sales, 'POST', `/sales/repairs/estimates/${sent.id}/answer`, { version: sent.version, answer: 'ACCEPTED', how: 'By phone with the brand’s buyer (made up)', answeredByName: 'Seed Buyer One' })
    expect(answered.repair.stage).toBe('APPROVED')
    const moved = await ok(P.sales, 'POST', `/sales/service/cases/${G.case.id}/status`, { version: G.case.version, to: 'WAITING_PART', message: 'The repair is approved; we wait for the thread (made up).' })
    expect(moved.notified).toMatchObject({ sent: true, to: BUYER })
    await settle()
  })

  // ---- S: a safety report ------------------------------------------------------------------------------------------------------

  it('S01 a product-safety report from a mail: its SAFETY case, the injury kept apart; no list, export, search, case or register entry shows the injury words; only the product-safety role opens them, each opening recorded', async () => {
    const answer = await ok(P.inspector, 'POST', '/sales/safety-reports', {
      companyId: companyA(),
      source: 'MAIL',
      partyId: id('party:P1'),
      serial: 'SEED-SN-0002',
      whatHappened: HAPPENED,
      wornAsIntended: true,
      accident: true,
      occurredOn: '2026-11-01',
      place: 'Made-up: a track day, turn 4',
      injured: true,
      injuryConsent: true,
      injuryWords: INJURY,
      reporter: { name: 'Made-up Rider', email: 'rider.gf5@example.com', phone: '+39 000 000 0000' },
    }, 201)
    const report = answer.report
    keep(report.id, answer.serviceCase.id)
    expect(report.injury).toEqual({ recorded: true, mayOpen: expect.any(Boolean) })
    const words = INJURY.slice(14, 40)
    const filed = await ok(P.inspector, 'POST', `/sales/safety-reports/${report.id}/register-entry`, { version: report.version })
    expect(filed.registerEntry.opened).toBe(true)
    keep(filed.registerEntry.id)
    // No list, read or export shows the words.
    for (const [who, url] of [[P.sales, '/sales/safety-reports'], [P.sales, `/sales/safety-reports/${report.id}`], [P.sales, '/sales/safety-reports/accident-log'], [P.sales, '/sales/safety-reports/counts'], [P.sales, `/sales/service/cases/${answer.serviceCase.id}`], [P.sales, `/search?q=${encodeURIComponent(report.number)}`]] as const) {
      expect(JSON.stringify(await ok(who, 'GET', url)), url).not.toContain(words)
    }
    await settle()
    const exported = async (who: Person, listKey: string, query: string) => {
      const columns = Object.keys(EXPORT_SOURCES.find((source) => source.listKey === listKey)!.columns).map((key) => ({ key, label: key }))
      const { job } = await ok(who, 'POST', '/exports', { listKey, format: 'CSV', query, columns, title: listKey, locale: 'it' }, 201)
      keep(job.id)
      await settle()
      const done = (await ok(who, 'GET', `/exports/${job.id}`)).job
      expect(done, `${listKey}: ${done.failureReason}`).toMatchObject({ status: 'DONE' })
      const { download } = await ok(who, 'GET', `/exports/${job.id}/download`)
      return (await w.h.app.inject({ method: 'GET', url: download.url, headers: download.headers })).body
    }
    const cases = await exported(P.sales, 'sales.service', 'view=open')
    expect(cases).toContain(answer.serviceCase.number)
    expect(cases).not.toContain(words)
    const register = await exported(P.inspector, 'compliance.register', '')
    expect(register).not.toContain(words)
    // REFUSAL: sales may not open the injury; the product-safety role may, and the opening is recorded first.
    await ok(P.sales, 'POST', `/sales/safety-reports/${report.id}/injury/open`, {}, 403)
    const opened = await ok(P.inspector, 'POST', `/sales/safety-reports/${report.id}/injury/open`, {})
    expect(opened.injury).toMatchObject({ injured: true, words: INJURY })
    expect(await admin(w, `SELECT count(*)::int AS n FROM "AuditLog" WHERE "recordId" = $1 AND action = 'safetyReports.injuryOpened'`, [report.id])).toEqual([{ n: 1 }])
    for (const [table, column] of [['AuditLog', 'after'], ['AuditLog', 'before'], ['OutboxEvent', 'payload'], ['IdempotencyReceipt', 'response'], ['ServiceCase', 'problem'], ['PpeRegisterEntry', 'description'], ['SearchEntry', 'searchText']] as const) {
      expect(await admin(w, `SELECT count(*)::int AS n FROM "${table}" WHERE "tenantId" = $1 AND "${column}"::text LIKE $2`, [w.tenant.id, `%${words}%`]), `${table}.${column}`).toEqual([{ n: 0 }])
    }
    expect(w.h.ses.mails.some((mail) => JSON.stringify(mail).includes(words))).toBe(false)
  })

  // ---- F: the W2b-4 follow-ups ---------------------------------------------------------------------------------------------------

  it('F01 an internal fit round of the configurable jacket: its sample work order made without an order line', async () => {
    const { round } = await ok(P.manager, 'POST', '/sales/samples/rounds', { styleId: G.jkt05.id, companyId: companyA(), kind: 'FIT', cells: [{ colourwayId: G.jkt05.blk, size: '52', quantity: 1 }], dueDate: '2030-01-29', instructions: 'Internal fit of the liner and the name (made up).' }, 201)
    keep(round.id)
    const options = await ok(P.manager, 'GET', `/sales/samples/rounds/${round.id}/work-order-options`)
    expect(options.withoutLine).toMatchObject({ allowed: true, refusal: null })
    const { workOrder } = await ok(P.manager, 'POST', `/sales/samples/rounds/${round.id}/work-orders`, {}, 201)
    keep(workOrder.id)
    expect((await ok(P.manager, 'GET', `/production/work-orders/${workOrder.id}`)).workOrder).toMatchObject({ kind: 'SAMPLE' })
    const read = (await ok(P.manager, 'GET', `/sales/samples/rounds/${round.id}`)).round
    expect((read.workOrdersList as Json[]).find((entry) => entry.id === workOrder.id)).toMatchObject({ withoutOrderLine: true })
    await settle()
  })

  it('F02 Time & action: the red jackets’ order has only a pre-production sample work order, so no production start; the jacket’s order starts with its production work order alone', async () => {
    const order2 = (await ok(P.sales, 'GET', `/sales/orders/${G.order2.id}`)).order
    const { round } = await ok(P.manager, 'POST', '/sales/samples/rounds', { styleId: G.jkt02.id, companyId: companyA(), kind: 'PRE_PRODUCTION', partyId: id('party:P1'), cells: [{ colourwayId: G.jkt02.red, size: '52', quantity: 1 }], dueDate: '2030-01-29', instructions: 'Pre-production sample, red 52 (made up).' }, 201)
    keep(round.id)
    const { workOrder } = await ok(P.manager, 'POST', `/sales/samples/rounds/${round.id}/work-orders`, { lines: [{ salesOrderLineId: order2.lines[0].id }] }, 201)
    keep(workOrder.id)
    const world = await ok(P.planner, 'GET', `/planning/milestones?companyId=${companyA()}`)
    const of = (orderId: string) => (world.orders as Json[]).find((order) => order.id === orderId)!
    const byKind = (order: Json) => Object.fromEntries((order.workOrders.byKind as Json[]).map((entry) => [entry.kind, entry]))
    const red = of(G.order2.id)
    expect(byKind(red).SAMPLE).toMatchObject({ count: 1 })
    expect(byKind(red).SIZE_GRID?.count ?? 0).toBe(0)
    expect((red.milestones as Json[]).find((milestone) => milestone.kind === 'START')?.actual ?? null).toBeNull()
    const jacket = of(G.order.id)
    expect(byKind(jacket).SIZE_GRID).toMatchObject({ count: 1, notStarted: 0 })
    const start = (jacket.milestones as Json[]).find((milestone) => milestone.kind === 'START')!
    expect(start.actual, JSON.stringify(start)).toEqual(expect.any(String))
    await settle()
  })

  // ---- Z: the end checks ---------------------------------------------------------------------------------------------------------

  it('Z1 every record the flow made has its audit rows; the W2b-5 events fired; the worker never retried; no route answered 500; the outbox is empty', async () => {
    await settle()
    const ids = [...made]
    const audited = new Set((await admin<{ recordId: string }>(w, 'SELECT DISTINCT "recordId"::text AS "recordId" FROM "AuditLog" WHERE "recordId" = ANY($1::uuid[])', [ids])).map((row) => row.recordId))
    const named = (recordId: string) => `${recordId} (${Object.entries(G).filter(([, value]) => JSON.stringify(value ?? null).includes(recordId)).map(([key]) => `G.${key}`).join(', ')})`
    expect(ids.filter((recordId) => !audited.has(recordId)).map(named)).toEqual([])
    const events = new Set((await admin<{ type: string }>(w, 'SELECT DISTINCT type FROM "OutboxEvent" WHERE "tenantId" = $1', [w.tenant.id])).map((row) => row.type))
    expect(EVENTS.filter((type) => !events.has(type)), `seen: ${[...events].sort().join(' ')}`).toEqual([])
    expect(w.retried).toEqual([])
    expect(unexpected.map((report) => `${report.context.method} ${report.context.route}: ${report.name}: ${report.message} ${report.stack.slice(0, 3).join(' | ')}`)).toEqual([])
    expect(await admin(w, `SELECT type, status::text AS status FROM "OutboxEvent" WHERE "tenantId" = $1 AND status <> 'PUBLISHED'`, [w.tenant.id])).toEqual([])
  })
})
