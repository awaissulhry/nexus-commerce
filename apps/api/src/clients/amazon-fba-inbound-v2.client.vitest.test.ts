/**
 * Step 4 Send to FBA — the FBA Inbound v2024-03-20 client against Amazon's own example answers
 * (`services/fba-inbound/__fixtures__/amazon-inbound-2024-03-20.json`, made from the published model by
 * `scripts/fba-inbound-fixtures.mjs`). Nothing leaves the machine: a recording transport answers with the examples.
 *
 *  - every call: method, path (params encoded), query, and a body that has every field the model requires;
 *  - the five fixes: A per-item prepOwner / labelOwner, B inboundPlanId from the create answer, C the calls that were
 *    missing, D labels through v0 getLabels with the shipmentConfirmationId, E the transportationOptions path;
 *  - Amazon's 400 answers become AmazonInboundError with Amazon's words; a lost answer is transient;
 *  - the writes switch: POST / PUT refused (nothing sent) unless NEXUS_ENABLE_FBA_INBOUND_SEND=1; GET always allowed;
 *  - the real transport is the channel gateway (amazonSellerFetch) with the account named.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fixture from '../services/fba-inbound/__fixtures__/amazon-inbound-2024-03-20.json' with { type: 'json' }

vi.mock('../db.js', () => ({ default: {} }))
const gateway = vi.hoisted(() => ({ calls: [] as any[], answer: null as null | (() => Promise<Response>) }))
vi.mock('../services/gateway/amazon-sdk.js', () => ({
  amazonSellerFetch: vi.fn(async (input: unknown) => {
    gateway.calls.push(input)
    if (!gateway.answer) throw new Error('no answer set')
    return gateway.answer()
  }),
}))

import * as client from './amazon-fba-inbound-v2.client.js'
import { bodyProblems } from '../services/fba-inbound/fake-amazon.js'

type Example = { status: number; request: { path: Record<string, string>; query: Record<string, unknown>; body: any }; response: any }
const ops = fixture.operations as unknown as Record<string, { method: string; path: string; body: string | null; query: string[]; examples: Example[] }>
const ok = (op: string): Example => ops[op].examples.find(e => e.status < 300)!
const bad = (op: string): Example => ops[op].examples.find(e => e.status === 400)!
const ACCOUNT = 'conn-amazon-1'

interface Sent { method: string; path: string; operation: string; body: unknown; accountId: string }
let sent: Sent[] = []
let respond: (op: string) => { status: number; body: unknown } = op => ({ status: ok(op).status, body: ok(op).response })
const recorder: client.InboundTransport = {
  kind: 'amazon',
  async send(request) {
    sent.push({ method: request.method, path: request.path, operation: request.operation, body: request.body, accountId: request.accountId })
    const answer = respond(request.operation.replace(/^fbaInbound\./, ''))
    return { status: answer.status, text: JSON.stringify(answer.body) }
  },
}

/** Each operation called with the parameters of Amazon's example. */
const callers: Record<string, (ex: Example) => Promise<unknown>> = {
  listInboundPlans: ex => client.listInboundPlans(ACCOUNT, { status: ex.request.query.status as never, sortBy: ex.request.query.sortBy as never, sortOrder: ex.request.query.sortOrder as never, pageSize: ex.request.query.pageSize as number, paginationToken: ex.request.query.paginationToken as string }),
  createInboundPlan: ex => client.createInboundPlan(ACCOUNT, ex.request.body),
  getInboundOperationStatus: ex => client.getInboundOperationStatus(ACCOUNT, ex.request.path.operationId),
  cancelInboundPlan: ex => client.cancelInboundPlan(ACCOUNT, ex.request.path.inboundPlanId),
  generatePackingOptions: ex => client.generatePackingOptions(ACCOUNT, ex.request.path.inboundPlanId),
  listPackingOptions: ex => client.listPackingOptions(ACCOUNT, ex.request.path.inboundPlanId, ex.request.query.paginationToken as string),
  listPackingGroupItems: ex => client.listPackingGroupItems(ACCOUNT, ex.request.path.inboundPlanId, ex.request.path.packingGroupId, ex.request.query.paginationToken as string),
  confirmPackingOption: ex => client.confirmPackingOption(ACCOUNT, ex.request.path.inboundPlanId, ex.request.path.packingOptionId),
  setPackingInformation: ex => client.setPackingInformation(ACCOUNT, ex.request.path.inboundPlanId, ex.request.body),
  generatePlacementOptions: ex => client.generatePlacementOptions(ACCOUNT, ex.request.path.inboundPlanId),
  listPlacementOptions: ex => client.listPlacementOptions(ACCOUNT, ex.request.path.inboundPlanId, ex.request.query.paginationToken as string),
  confirmPlacementOption: ex => client.confirmPlacementOption(ACCOUNT, ex.request.path.inboundPlanId, ex.request.path.placementOptionId),
  getShipment: ex => client.getShipment(ACCOUNT, ex.request.path.inboundPlanId, ex.request.path.shipmentId),
  listShipmentItems: ex => client.listShipmentItems(ACCOUNT, ex.request.path.inboundPlanId, ex.request.path.shipmentId, ex.request.query.paginationToken as string),
  listShipmentBoxes: ex => client.listShipmentBoxes(ACCOUNT, ex.request.path.inboundPlanId, ex.request.path.shipmentId, ex.request.query.paginationToken as string),
  generateTransportationOptions: ex => client.generateTransportationOptions(ACCOUNT, ex.request.path.inboundPlanId, ex.request.body),
  listTransportationOptions: ex => client.listTransportationOptions(ACCOUNT, ex.request.path.inboundPlanId, { placementOptionId: ex.request.query.placementOptionId as string, shipmentId: ex.request.query.shipmentId as string, paginationToken: ex.request.query.paginationToken as string }),
  confirmTransportationOptions: ex => client.confirmTransportationOptions(ACCOUNT, ex.request.path.inboundPlanId, ex.request.body.transportationSelections),
  generateDeliveryWindowOptions: ex => client.generateDeliveryWindowOptions(ACCOUNT, ex.request.path.inboundPlanId, ex.request.path.shipmentId),
  listDeliveryWindowOptions: ex => client.listDeliveryWindowOptions(ACCOUNT, ex.request.path.inboundPlanId, ex.request.path.shipmentId, ex.request.query.paginationToken as string),
  confirmDeliveryWindowOptions: ex => client.confirmDeliveryWindowOptions(ACCOUNT, ex.request.path.inboundPlanId, ex.request.path.shipmentId, ex.request.path.deliveryWindowOptionId),
  updateShipmentTrackingDetails: ex => client.updateShipmentTrackingDetails(ACCOUNT, ex.request.path.inboundPlanId, ex.request.path.shipmentId, ex.request.body.trackingDetails.spdTrackingDetail.spdTrackingItems),
}

const expectedPath = (op: string, ex: Example) =>
  ops[op].path.replace(/\{(\w+)\}/g, (_m, name: string) => encodeURIComponent(ex.request.path[name]))

beforeEach(() => {
  sent = []
  respond = op => ({ status: ok(op).status, body: ok(op).response })
  process.env.NEXUS_ENABLE_FBA_INBOUND_SEND = '1'
  client.setInboundTransportForTests(recorder)
})
afterEach(() => {
  delete process.env.NEXUS_ENABLE_FBA_INBOUND_SEND
  client.setInboundTransportForTests(null)
  gateway.calls = []
  gateway.answer = null
})

describe('every call against Amazon\'s example request', () => {
  it('the fixture covers every operation the client wraps, each with Amazon\'s own answer', () => {
    expect(Object.keys(callers).sort()).toEqual(Object.keys(ops).sort())
    for (const op of Object.keys(ops)) expect(ops[op].examples.some(e => e.status < 300), op).toBe(true)
    expect(fixture.source.model).toContain('fulfillmentInbound_2024-03-20.json')
  })

  for (const op of Object.keys(callers)) {
    it(`${op}: method, path, query and a body with the model's required fields`, async () => {
      const ex = ok(op)
      await callers[op](ex)
      expect(sent).toHaveLength(1)
      const [request] = sent
      expect(request.accountId).toBe(ACCOUNT)
      expect(request.operation).toBe(`fbaInbound.${op}`)
      expect(request.method).toBe(ops[op].method)
      const url = new URL(`https://x${request.path}`)
      expect(url.pathname).toBe(expectedPath(op, ex))
      for (const [name, value] of Object.entries(ex.request.query)) {
        if (name === 'pageSize' && op !== 'listInboundPlans') continue // the client asks for its own page size
        expect(url.searchParams.get(name), `${op} ?${name}`).toBe(String(value))
      }
      for (const name of url.searchParams.keys()) expect(ops[op].query, `${op} sends ?${name}`).toContain(name)
      if (ops[op].body) expect(bodyProblems(ops[op].body!, request.body), op).toEqual([])
      else if (request.method !== 'GET') expect(request.body ?? null, op).toBeNull()
    })
  }

  it('the bodies the client copies are Amazon\'s example bodies exactly', async () => {
    for (const op of ['createInboundPlan', 'setPackingInformation', 'confirmTransportationOptions']) {
      sent = []
      await callers[op](ok(op))
      expect(sent[0].body, op).toEqual(ok(op).request.body)
    }
    sent = []
    await callers.generateTransportationOptions(ok('generateTransportationOptions'))
    const config = ok('generateTransportationOptions').request.body.shipmentTransportationConfigurations[0]
    expect(sent[0].body).toEqual({
      placementOptionId: ok('generateTransportationOptions').request.body.placementOptionId,
      // Small parcel: no pallets or freight information.
      shipmentTransportationConfigurations: [{ shipmentId: config.shipmentId, readyToShipWindow: config.readyToShipWindow, contactInformation: config.contactInformation }],
    })
    sent = []
    await callers.updateShipmentTrackingDetails(ok('updateShipmentTrackingDetails'))
    expect(sent[0].body).toEqual({ trackingDetails: { spdTrackingDetail: ok('updateShipmentTrackingDetails').request.body.trackingDetails.spdTrackingDetail } })
    sent = []
    await callers.generatePlacementOptions(ok('generatePlacementOptions'))
    expect(sent[0].body).toEqual({}) // no custom placement: Amazon places the units
  })

  it('reads Amazon\'s answers: lists, pages, operations', async () => {
    const packing = await client.listPackingOptions(ACCOUNT, 'wf1234abcd-1234-abcd-5678-1234abcd5678')
    expect(packing.packingOptions[0]).toMatchObject({ packingOptionId: 'po1234abcd-1234-abcd-5678-1234abcd5678', packingGroups: ['pg1234abcd-1234-abcd-5678-1234abcd5678'], status: 'OFFERED' })
    expect(packing.nextToken).toBe('nextPaginationToken')
    const operation = await client.getInboundOperationStatus(ACCOUNT, '1234abcd-1234-abcd-5678-1234abcd5678')
    expect(operation).toMatchObject({ operationStatus: 'SUCCESS', operationProblems: [{ code: 'DimensionMismatch' }] })
    const shipment = await client.getShipment(ACCOUNT, 'wf1234abcd-1234-abcd-5678-1234abcd5678', 'sh1234abcd-1234-abcd-5678-1234abcd5678')
    expect(shipment).toMatchObject({ shipmentConfirmationId: 'FBA1234ABCD', destination: { warehouseId: 'YYZ5' } })
    const boxes = await client.listShipmentBoxes(ACCOUNT, 'wf1234abcd-1234-abcd-5678-1234abcd5678', 'sh1234abcd-1234-abcd-5678-1234abcd5678')
    expect(boxes.boxes[0]).toMatchObject({ boxId: 'boxId', weight: { unit: 'KG', value: 5.5 } })
    const all = await client.allPages(async token => (token ? { items: [2], nextToken: null } : { items: [1], nextToken: 'next' }))
    expect(all).toEqual([1, 2])
  })

  it('Amazon\'s 400 answers become AmazonInboundError with Amazon\'s own words', async () => {
    for (const op of Object.keys(callers)) {
      const example = bad(op)
      respond = () => ({ status: 400, body: example.response })
      const error = await callers[op](ok(op)).then(() => null, e => e)
      expect(error, op).toBeInstanceOf(client.AmazonInboundError)
      expect(error.status).toBe(400)
      expect(error.transient).toBe(false)
      expect(error.errors[0].message, op).toBe(example.response.errors[0].message)
    }
  })
})

describe('the five fixes', () => {
  it('A — createInboundPlan: prepOwner / labelOwner on every item, nothing at the top level', async () => {
    await client.createInboundPlan(ACCOUNT, {
      destinationMarketplaces: ['APJ6JRA9NG5V4'],
      sourceAddress: { name: 'Test Sender', addressLine1: 'Via Prova 1', addressLine2: '', city: 'Testville', postalCode: '00000', countryCode: 'IT', phoneNumber: '+390000000000' },
      items: [{ msku: 'TEST-A', quantity: 12, prepOwner: 'SELLER', labelOwner: 'SELLER' }, { msku: 'TEST-B', quantity: 5, prepOwner: 'AMAZON', labelOwner: 'AMAZON' }],
      name: 'Nexus IT 2026-10-08 #abc123',
    })
    const body = sent[0].body as Record<string, any>
    expect(Object.keys(body).sort()).toEqual(['destinationMarketplaces', 'items', 'name', 'sourceAddress'])
    expect(body.items).toEqual([
      { msku: 'TEST-A', quantity: 12, prepOwner: 'SELLER', labelOwner: 'SELLER' },
      { msku: 'TEST-B', quantity: 5, prepOwner: 'AMAZON', labelOwner: 'AMAZON' },
    ])
    expect(body.sourceAddress).not.toHaveProperty('addressLine2') // an empty optional line is left out (minLength 1)
    expect(bodyProblems('CreateInboundPlanRequest', body)).toEqual([])
    // The model check is real: the old body shape (owners at the top, none per item) is refused.
    expect(bodyProblems('CreateInboundPlanRequest', { ...body, prepOwner: 'SELLER', items: [{ msku: 'TEST-A', quantity: 12 }] }))
      .toEqual(['CreateInboundPlanRequest.items[0].labelOwner: required', 'CreateInboundPlanRequest.items[0].prepOwner: required'])
  })

  it('B — createInboundPlan returns the inboundPlanId of Amazon\'s 202 answer, with the operationId', async () => {
    const created = await client.createInboundPlan(ACCOUNT, ok('createInboundPlan').request.body)
    expect(created).toEqual({ inboundPlanId: 'wf1234abcd-1234-abcd-5678-1234abcd5678', operationId: '1234abcd-1234-abcd-5678-1234abcd5678' })
    respond = () => ({ status: 202, body: { operationId: 'op-only' } })
    await expect(client.createInboundPlan(ACCOUNT, ok('createInboundPlan').request.body)).rejects.toThrow(/without an inboundPlanId/)
  })

  it('C — the calls that were missing exist, with Amazon\'s method and path', () => {
    for (const op of ['generatePackingOptions', 'listPackingGroupItems', 'setPackingInformation', 'generatePlacementOptions', 'getShipment', 'listShipmentItems',
      'listShipmentBoxes', 'generateTransportationOptions', 'generateDeliveryWindowOptions', 'listDeliveryWindowOptions', 'confirmDeliveryWindowOptions',
      'updateShipmentTrackingDetails', 'cancelInboundPlan', 'listInboundPlans']) {
      expect(typeof (client as Record<string, unknown>)[op], op).toBe('function')
    }
    expect(ops.cancelInboundPlan.method).toBe('PUT')
    expect(ops.updateShipmentTrackingDetails.method).toBe('PUT')
  })

  it('D — labels: v0 getLabels with the shipmentConfirmationId (FBA15…), A4 x4, one UNIQUE label per box', async () => {
    respond = () => ({ status: 200, body: fixture.v0.getLabels.response })
    const labels = await client.getShipmentLabels(ACCOUNT, { shipmentConfirmationId: 'FBA15ABC0001', packageLabelsToPrint: ['FBA15ABC0001U000001', 'FBA15ABC0001U000002'] })
    expect(labels).toEqual({ downloadUrl: fixture.v0.getLabels.response.payload.DownloadURL })
    const url = new URL(`https://x${sent[0].path}`)
    expect(sent[0].method).toBe('GET')
    expect(url.pathname).toBe('/fba/inbound/v0/shipments/FBA15ABC0001/labels')
    expect(Object.fromEntries(url.searchParams)).toEqual({ PageType: 'PackageLabel_A4_4', LabelType: 'UNIQUE', PackageLabelsToPrint: 'FBA15ABC0001U000001,FBA15ABC0001U000002' })
    respond = () => ({ status: 200, body: { payload: {} } })
    await expect(client.getShipmentLabels(ACCOUNT, { shipmentConfirmationId: 'FBA15ABC0001', packageLabelsToPrint: ['x'] })).rejects.toThrow(/no label link/)
  })

  it('E — transportation options: GET /inboundPlans/{id}/transportationOptions?placementOptionId=…, shippingMode GROUND_SMALL_PARCEL', async () => {
    const answer = await client.listTransportationOptions(ACCOUNT, 'wf1234abcd-1234-abcd-5678-1234abcd5678', { placementOptionId: 'pl1234abcd-1234-abcd-5678-1234abcd5678' })
    const url = new URL(`https://x${sent[0].path}`)
    expect(url.pathname).toBe('/inbound/fba/2024-03-20/inboundPlans/wf1234abcd-1234-abcd-5678-1234abcd5678/transportationOptions')
    expect(url.pathname).not.toContain('/shipments/')
    expect(url.searchParams.get('placementOptionId')).toBe('pl1234abcd-1234-abcd-5678-1234abcd5678')
    expect(answer.transportationOptions[0]).toMatchObject({ shippingMode: 'GROUND_SMALL_PARCEL', quote: { cost: { code: 'USD', amount: 500 } } })
  })
})

describe('the Amazon writes switch', () => {
  it('off: every POST / PUT is refused before the transport; GET still reads', async () => {
    delete process.env.NEXUS_ENABLE_FBA_INBOUND_SEND
    for (const op of Object.keys(callers).filter(op => ops[op].method !== 'GET')) {
      await expect(callers[op](ok(op)), op).rejects.toBeInstanceOf(client.InboundWritesOff)
    }
    expect(sent).toEqual([])
    await client.listPlacementOptions(ACCOUNT, 'wf1234abcd-1234-abcd-5678-1234abcd5678')
    expect(sent.map(s => s.method)).toEqual(['GET'])
  })
  it('only "1" turns it on', () => {
    expect(client.inboundWritesEnabled({ NEXUS_ENABLE_FBA_INBOUND_SEND: 'true' })).toBe(false)
    expect(client.inboundWritesEnabled({ NEXUS_ENABLE_FBA_INBOUND_SEND: '1' })).toBe(true)
    expect(() => client.assertInboundWrites('createInboundPlan', {})).toThrow(/off on this server/)
  })
})

describe('the real transport is the channel gateway', () => {
  it('amazonSellerFetch gets the account, method, path, ledger name and body', async () => {
    client.setInboundTransportForTests(null)
    expect(await client.inboundTransport({})).toBe(client.gatewayInboundTransport)
    gateway.answer = async () => new Response(JSON.stringify(ok('generatePlacementOptions').response), { status: 202 })
    const result = await client.generatePlacementOptions(ACCOUNT, 'wf1234abcd-1234-abcd-5678-1234abcd5678')
    expect(result).toEqual({ operationId: '1234abcd-1234-abcd-5678-1234abcd5678' })
    expect(gateway.calls).toEqual([{
      accountId: ACCOUNT, method: 'POST', path: '/inbound/fba/2024-03-20/inboundPlans/wf1234abcd-1234-abcd-5678-1234abcd5678/placementOptions',
      operation: 'fbaInbound.generatePlacementOptions', body: {},
    }])
  })
  it('no answer at all (GatewayNoAnswer) is a transient error, not a refusal', async () => {
    client.setInboundTransportForTests(null)
    gateway.answer = async () => { throw Object.assign(new Error('Amazon did not answer (x): socket hang up'), { name: 'GatewayNoAnswer' }) }
    const error = await client.listInboundPlans(ACCOUNT).then(() => null, e => e)
    expect(error).toBeInstanceOf(client.AmazonInboundError)
    expect(error.status).toBe(0)
    expect(error.transient).toBe(true)
  })
  it('a call without its account is refused before anything is sent', async () => {
    await expect(client.listInboundPlans('')).rejects.toThrow(/needs the Amazon account/)
    expect(sent).toEqual([])
  })
})
