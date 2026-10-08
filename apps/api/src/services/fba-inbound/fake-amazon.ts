/**
 * Step 4 Send to FBA — a FAKE Amazon for the FBA Inbound v2024-03-20 client (plan §6). A pure, in-memory state machine
 * behind the client's transport seam (`InboundTransport`), answering from Amazon's own example answers
 * (`__fixtures__/amazon-inbound-2024-03-20.json`, made by `scripts/fba-inbound-fixtures.mjs`) with EU values. It never
 * calls `fetch`: nothing leaves the process, so the channel-gateway ratchet is unchanged.
 *
 * What it does:
 *  - routes by method + path like Amazon; RECORDS every request (`requests`) with its parsed body and query;
 *  - checks every request body against the model's required fields and enums (`schemas` in the fixture) and answers
 *    400 like Amazon when one is missing — `invalid` lists them, so a test proves the client builds real bodies;
 *  - keeps plans, packing / placement options, shipments, boxes, tracking; an operation answers IN_PROGRESS
 *    `inProgressPolls` times (default 1), then SUCCESS;
 *  - a script injects trouble: an operation FAILED with problems, a 429, "accepted then the answer is lost" (the change
 *    is made at Amazon, then the transport throws ECONNRESET), an operation stuck IN_PROGRESS.
 *
 * Who may use it: tests (directly, through `setInboundTransportForTests`) and the private stack with
 * `NEXUS_FBA_INBOUND_FAKE=1` — honoured only when NODE_ENV is not production AND DATABASE_URL is a loopback host with a
 * `*test*` database name (`fakeAmazonGuard`); the client refuses the flag anywhere else.
 */
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { testDatabaseVerdict } from '../../lib/testing/database-target.js'
import type { InboundAnswer, InboundRequest, InboundTransport } from '../../clients/amazon-fba-inbound-v2.client.js'
import { FBA_FAKE_ENV } from './contract.js'

/* ── the guard ───────────────────────────────────────────────────────────────────────────────── */

export interface FakeAmazonVerdict { allowed: boolean; reason: string }

/**
 * May this process answer FBA inbound calls with the fake? Only when asked (`NEXUS_FBA_INBOUND_FAKE=1`), NOT in
 * production, and on a loopback database whose name contains "test" (the same URL rule as the API test guard, stricter:
 * `nexus_development` is not enough). Pure.
 */
export function fakeAmazonGuard(env: Record<string, string | undefined>): FakeAmazonVerdict {
  if (env[FBA_FAKE_ENV] !== '1') return { allowed: false, reason: `${FBA_FAKE_ENV} is not 1` }
  if ((env.NODE_ENV ?? '').toLowerCase() === 'production') return { allowed: false, reason: 'NODE_ENV is production' }
  const verdict = testDatabaseVerdict(env.DATABASE_URL)
  if (!verdict.allowed) return { allowed: false, reason: verdict.reason || 'DATABASE_URL is not a local test database' }
  if (!/test/i.test(verdict.database)) {
    return { allowed: false, reason: `database "${verdict.database}" on "${verdict.host}" is local but not a *test* database` }
  }
  return { allowed: true, reason: `loopback test database "${verdict.database}" on "${verdict.host}", NODE_ENV ${env.NODE_ENV ?? 'unset'}` }
}

/* ── the recorded answers ────────────────────────────────────────────────────────────────────── */

interface SchemaEntry { required: string[]; refs: Record<string, { def: string; array: boolean }>; enums: Record<string, string[]> }
interface Fixture {
  source: { model: string; commitDate: string; sha256: string }
  operations: Record<string, { method: string; path: string; body: string | null; query: string[]; examples: Array<{ status: number; request: any; response: any }> }>
  schemas: Record<string, SchemaEntry>
  v0: { getLabels: { response: any } }
  eu: {
    marketplaceId: string
    currency: string
    fulfilmentCentres: Array<{ warehouseId: string; city: string; stateOrProvinceCode: string; postalCode: string }>
    packingOption: any
    placementOption: any
    placementShipmentCounts: number[]
    shipment: any
    transportationOptions: { ownCarrier: any; partnered: any }
    deliveryWindowOption: any
    box: any
    failedOperation: any
  }
}

let fixtureCache: Fixture | null = null
/** Amazon's recorded answers (read once; the file is not part of a production build — the fake never runs there). */
export function inboundFixture(): Fixture {
  fixtureCache ??= JSON.parse(readFileSync(new URL('./__fixtures__/amazon-inbound-2024-03-20.json', import.meta.url), 'utf8')) as Fixture
  return fixtureCache
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

/** Problems of a body against the model: missing required fields and values outside an enum (`path: reason`). */
export function bodyProblems(def: string, value: unknown, path = def): string[] {
  const schema = inboundFixture().schemas[def]
  if (!schema) return []
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [`${path}: must be an object`]
  const obj = value as Record<string, unknown>
  const out: string[] = []
  for (const field of schema.required) {
    const v = obj[field]
    if (v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)) out.push(`${path}.${field}: required`)
  }
  for (const [field, allowed] of Object.entries(schema.enums)) {
    const v = obj[field]
    if (v !== undefined && v !== null && !allowed.includes(String(v))) out.push(`${path}.${field}: "${String(v)}" is not one of ${allowed.join(', ')}`)
  }
  for (const [field, ref] of Object.entries(schema.refs)) {
    const v = obj[field]
    if (v === undefined || v === null) continue
    if (ref.array) {
      if (!Array.isArray(v)) out.push(`${path}.${field}: must be a list`)
      else v.forEach((item, i) => out.push(...bodyProblems(ref.def, item, `${path}.${field}[${i}]`)))
    } else out.push(...bodyProblems(ref.def, v, `${path}.${field}`))
  }
  return out
}

/* ── the fake ────────────────────────────────────────────────────────────────────────────────── */

export interface FakeAmazonScript {
  /** IN_PROGRESS answers before an operation settles (default 1). Per operation name overrides it. */
  inProgressPolls?: number
  pollsByOperation?: Record<string, number>
  /** The next operation of this name ends FAILED with these problems (Amazon's example problem when []). Used once. */
  fail?: Record<string, Array<{ code: string; message: string; severity?: string; details?: string }>>
  /** Answer 429 to the next N calls of this operation name. */
  throttle?: Record<string, number>
  /** Make the change at Amazon, then lose the answer (the transport throws ECONNRESET). Used once per name. */
  crashAfter?: string[]
  /** Answer 400 with this message to the next call of this operation name. Used once. */
  reject?: Record<string, string>
  /** Packing groups in the best packing option (default 1). */
  packingGroups?: number
  /** Placement options offered (default 2: one shipment, then two). */
  placements?: number
  /** Also offer an Amazon-partnered carrier (default false: own carrier only). */
  partnered?: boolean
}

export interface FakeRequest {
  operation: string
  method: string
  path: string
  query: Record<string, string>
  body: unknown
  accountId: string
}

interface FakeShipment {
  shipmentId: string
  placementOptionId: string
  warehouseId: string
  city: string
  confirmationId: string | null
  transportOptions: any[]
  deliveryWindows: any[]
  selectedTransportationOptionId: string | null
  selectedDeliveryWindowId: string | null
  tracking: Array<{ boxId: string; trackingId: string }> | null
  boxes: Array<{ boxId: string; packageId: string; dims: any; weight: any; items: Array<{ msku: string; quantity: number }> }>
}
interface FakePlan {
  inboundPlanId: string
  name: string
  status: 'ACTIVE' | 'VOIDED' | 'SHIPPED'
  createdAt: string
  marketplaceIds: string[]
  sourceAddress: any
  items: Array<{ msku: string; quantity: number; prepOwner: string; labelOwner: string }>
  packingOptions: any[]
  packingGroups: Map<string, Array<{ msku: string; quantity: number }>>
  packingInfo: any | null
  placementOptions: any[]
  shipments: Map<string, FakeShipment>
}
interface FakeOperation { operationId: string; operation: string; pollsLeft: number; status: 'SUCCESS' | 'FAILED'; problems: any[] }

const ROUTES: Array<[string, RegExp, string]> = [
  ['POST', /^\/inbound\/fba\/2024-03-20\/inboundPlans$/, 'createInboundPlan'],
  ['GET', /^\/inbound\/fba\/2024-03-20\/inboundPlans$/, 'listInboundPlans'],
  ['GET', /^\/inbound\/fba\/2024-03-20\/operations\/([^/]+)$/, 'getInboundOperationStatus'],
  ['PUT', /^\/inbound\/fba\/2024-03-20\/inboundPlans\/([^/]+)\/cancellation$/, 'cancelInboundPlan'],
  ['POST', /^\/inbound\/fba\/2024-03-20\/inboundPlans\/([^/]+)\/packingOptions$/, 'generatePackingOptions'],
  ['GET', /^\/inbound\/fba\/2024-03-20\/inboundPlans\/([^/]+)\/packingOptions$/, 'listPackingOptions'],
  ['POST', /^\/inbound\/fba\/2024-03-20\/inboundPlans\/([^/]+)\/packingOptions\/([^/]+)\/confirmation$/, 'confirmPackingOption'],
  ['GET', /^\/inbound\/fba\/2024-03-20\/inboundPlans\/([^/]+)\/packingGroups\/([^/]+)\/items$/, 'listPackingGroupItems'],
  ['POST', /^\/inbound\/fba\/2024-03-20\/inboundPlans\/([^/]+)\/packingInformation$/, 'setPackingInformation'],
  ['POST', /^\/inbound\/fba\/2024-03-20\/inboundPlans\/([^/]+)\/placementOptions$/, 'generatePlacementOptions'],
  ['GET', /^\/inbound\/fba\/2024-03-20\/inboundPlans\/([^/]+)\/placementOptions$/, 'listPlacementOptions'],
  ['POST', /^\/inbound\/fba\/2024-03-20\/inboundPlans\/([^/]+)\/placementOptions\/([^/]+)\/confirmation$/, 'confirmPlacementOption'],
  ['POST', /^\/inbound\/fba\/2024-03-20\/inboundPlans\/([^/]+)\/transportationOptions\/confirmation$/, 'confirmTransportationOptions'],
  ['POST', /^\/inbound\/fba\/2024-03-20\/inboundPlans\/([^/]+)\/transportationOptions$/, 'generateTransportationOptions'],
  ['GET', /^\/inbound\/fba\/2024-03-20\/inboundPlans\/([^/]+)\/transportationOptions$/, 'listTransportationOptions'],
  ['GET', /^\/inbound\/fba\/2024-03-20\/inboundPlans\/([^/]+)\/shipments\/([^/]+)$/, 'getShipment'],
  ['GET', /^\/inbound\/fba\/2024-03-20\/inboundPlans\/([^/]+)\/shipments\/([^/]+)\/items$/, 'listShipmentItems'],
  ['GET', /^\/inbound\/fba\/2024-03-20\/inboundPlans\/([^/]+)\/shipments\/([^/]+)\/boxes$/, 'listShipmentBoxes'],
  ['POST', /^\/inbound\/fba\/2024-03-20\/inboundPlans\/([^/]+)\/shipments\/([^/]+)\/deliveryWindowOptions$/, 'generateDeliveryWindowOptions'],
  ['GET', /^\/inbound\/fba\/2024-03-20\/inboundPlans\/([^/]+)\/shipments\/([^/]+)\/deliveryWindowOptions$/, 'listDeliveryWindowOptions'],
  ['POST', /^\/inbound\/fba\/2024-03-20\/inboundPlans\/([^/]+)\/shipments\/([^/]+)\/deliveryWindowOptions\/([^/]+)\/confirmation$/, 'confirmDeliveryWindowOptions'],
  ['PUT', /^\/inbound\/fba\/2024-03-20\/inboundPlans\/([^/]+)\/shipments\/([^/]+)\/trackingDetails$/, 'updateShipmentTrackingDetails'],
  ['GET', /^\/fba\/inbound\/v0\/shipments\/([^/]+)\/labels$/, 'getLabels'],
]

/** An Amazon-shaped id of 38 characters: `wf` + a 36-character uuid-like tail (Amazon's inboundPlanId pattern). Each
 *  fake has its own seed, so ids never repeat across fakes (Amazon's are unique; the plan row keeps them unique). */
function fakeId(prefix: string, seed: string, n: number): string {
  return `${prefix}${seed}-fa4e-4000-8000-${String(n).padStart(12, '0')}`
}

export class FakeAmazon {
  readonly requests: FakeRequest[] = []
  /** Bodies that missed a required field of the model (each one also answered 400). */
  readonly invalid: Array<{ operation: string; problems: string[] }> = []
  readonly plans = new Map<string, FakePlan>()
  readonly operations = new Map<string, FakeOperation>()
  script: FakeAmazonScript
  private counter = 0
  private readonly seed = randomBytes(4).toString('hex')
  private readonly now: () => Date
  readonly transport: InboundTransport

  constructor(options: { now?: () => Date; script?: FakeAmazonScript } = {}) {
    this.now = options.now ?? (() => new Date())
    this.script = options.script ?? {}
    this.transport = { kind: 'fake', send: request => this.send(request) }
  }

  /** The recorded requests of one operation. */
  calls(operation: string): FakeRequest[] {
    return this.requests.filter(r => r.operation === operation)
  }
  /** Settle every operation still IN_PROGRESS on its next poll. */
  finishOperations(): void {
    for (const op of this.operations.values()) op.pollsLeft = 0
  }

  private next(prefix: string): string {
    this.counter += 1
    return fakeId(prefix, this.seed, this.counter)
  }
  private iso(offsetMs = 0): string {
    return new Date(this.now().getTime() + offsetMs).toISOString()
  }

  async send(request: InboundRequest): Promise<InboundAnswer> {
    const url = new URL(`https://fake.invalid${request.path}`)
    const route = ROUTES.find(([method, pattern]) => method === request.method && pattern.test(url.pathname))
    const operation = route?.[2] ?? 'unknown'
    const params = route ? (url.pathname.match(route[1]) ?? []).slice(1).map(decodeURIComponent) : []
    const query = Object.fromEntries(url.searchParams.entries())
    this.requests.push({ operation, method: request.method, path: request.path, query, body: request.body === undefined ? null : clone(request.body), accountId: request.accountId })
    if (!route) return this.error(404, 'NotFound', `No such operation: ${request.method} ${url.pathname}`)

    const throttled = this.script.throttle?.[operation] ?? 0
    if (throttled > 0) {
      this.script.throttle![operation] = throttled - 1
      return this.error(429, 'QuotaExceeded', 'You exceeded your quota for the requested resource.')
    }
    const rejected = this.script.reject?.[operation]
    if (rejected) {
      delete this.script.reject![operation]
      return this.error(400, 'BadRequest', rejected)
    }
    const bodyDef = inboundFixture().operations[operation]?.body
    if (bodyDef) {
      const problems = bodyProblems(bodyDef, request.body)
      if (problems.length) {
        this.invalid.push({ operation, problems })
        return this.error(400, 'InvalidInput', problems.join('; '))
      }
    }

    const answer = this.handle(operation, params, query, request.body as any)
    const crash = this.script.crashAfter?.indexOf(operation) ?? -1
    if (crash >= 0) {
      this.script.crashAfter!.splice(crash, 1)
      throw Object.assign(new Error(`socket hang up after ${operation} was accepted`), { code: 'ECONNRESET' })
    }
    return answer
  }

  private json(status: number, body: unknown): InboundAnswer {
    return { status, text: JSON.stringify(body) }
  }
  private error(status: number, code: string, message: string): InboundAnswer {
    return this.json(status, { errors: [{ code, message }] })
  }
  private plan(id: string): FakePlan | null {
    return this.plans.get(id) ?? null
  }
  private operation(name: string, apply: () => void): InboundAnswer {
    const operationId = this.next('op').slice(2)
    const failure = this.script.fail?.[name]
    const polls = this.script.pollsByOperation?.[name] ?? this.script.inProgressPolls ?? 1
    if (failure) {
      delete this.script.fail![name]
      const example = clone(inboundFixture().eu.failedOperation.operationProblems)
      this.operations.set(operationId, { operationId, operation: name, pollsLeft: polls, status: 'FAILED', problems: failure.length ? failure.map(p => ({ severity: 'ERROR', details: '', ...p })) : example })
    } else {
      apply()
      this.operations.set(operationId, { operationId, operation: name, pollsLeft: polls, status: 'SUCCESS', problems: [] })
    }
    return this.json(202, { operationId })
  }

  private handle(operation: string, params: string[], query: Record<string, string>, body: any): InboundAnswer {
    const fx = inboundFixture()
    const [planId, second, third] = params
    if (operation === 'getLabels') {
      const response = clone(fx.v0.getLabels.response)
      response.payload.DownloadURL = `https://fake-amazon.invalid/fba/inbound/labels/${encodeURIComponent(planId)}.pdf?boxes=${encodeURIComponent(query.PackageLabelsToPrint ?? '')}`
      return this.json(200, response)
    }
    if (operation === 'createInboundPlan') {
      const inboundPlanId = this.next('wf')
      const answer = this.operation(operation, () => {
        this.plans.set(inboundPlanId, {
          inboundPlanId, name: body.name ?? `FBA (${this.iso()})`, status: 'ACTIVE', createdAt: this.iso(),
          marketplaceIds: body.destinationMarketplaces, sourceAddress: body.sourceAddress, items: clone(body.items),
          packingOptions: [], packingGroups: new Map(), packingInfo: null, placementOptions: [], shipments: new Map(),
        })
      })
      return this.json(202, { inboundPlanId, operationId: JSON.parse(answer.text).operationId })
    }
    if (operation === 'listInboundPlans') {
      let list = [...this.plans.values()]
      if (query.status) list = list.filter(p => p.status === query.status)
      list.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))
      if ((query.sortOrder ?? 'ASC') === 'DESC') list.reverse()
      return this.json(200, { inboundPlans: list.map(p => ({ inboundPlanId: p.inboundPlanId, name: p.name, createdAt: p.createdAt, lastUpdatedAt: p.createdAt, status: p.status, marketplaceIds: p.marketplaceIds, sourceAddress: p.sourceAddress })), pagination: {} })
    }
    if (operation === 'getInboundOperationStatus') {
      const op = this.operations.get(planId)
      if (!op) return this.error(400, 'BadRequest', 'The requested operationId does not exist.')
      const template = clone(fx.operations.getInboundOperationStatus.examples.find(e => e.status === 200)!.response)
      if (op.pollsLeft > 0) {
        op.pollsLeft -= 1
        return this.json(200, { ...template, operationId: op.operationId, operation: op.operation, operationStatus: 'IN_PROGRESS', operationProblems: [] })
      }
      return this.json(200, { ...template, operationId: op.operationId, operation: op.operation, operationStatus: op.status, operationProblems: op.problems })
    }

    const plan = this.plan(planId)
    if (!plan) return this.error(400, 'BadRequest', 'The requested inbound plan does not exist.')
    if (plan.status === 'VOIDED' && operation !== 'listPackingOptions' && operation !== 'listPlacementOptions') {
      return this.error(400, 'BadRequest', operation === 'cancelInboundPlan' ? 'The inbound plan is already cancelled.' : 'The inbound plan is cancelled.')
    }
    switch (operation) {
      case 'cancelInboundPlan':
        return this.operation(operation, () => { plan.status = 'VOIDED' })
      case 'generatePackingOptions':
        return this.operation(operation, () => this.makePackingOptions(plan))
      case 'listPackingOptions':
        return this.json(200, { packingOptions: plan.packingOptions, pagination: {} })
      case 'listPackingGroupItems': {
        const items = plan.packingGroups.get(second)
        if (!items) return this.error(400, 'BadRequest', 'The requested packingGroupId does not exist for the specified inbound plan.')
        return this.json(200, { items: items.map(i => ({ ...clone(fx.operations.listPackingGroupItems.examples[0].response.items[0]), msku: i.msku, quantity: i.quantity, asin: `ASIN-${i.msku}`, fnsku: `X00${i.msku}`, prepInstructions: [] })), pagination: {} })
      }
      case 'confirmPackingOption': {
        const option = plan.packingOptions.find(o => o.packingOptionId === second)
        if (!option) return this.error(400, 'BadRequest', 'The requested packingOptionId does not exist for the given inbound plan.')
        return this.operation(operation, () => {
          for (const o of plan.packingOptions) o.status = o.packingOptionId === second ? 'ACCEPTED' : 'EXPIRED'
        })
      }
      case 'setPackingInformation':
        return this.operation(operation, () => { plan.packingInfo = clone(body) })
      case 'generatePlacementOptions':
        if (!plan.packingInfo) return this.error(400, 'BadRequest', 'The inbound plan is not in a valid state to generate placement options.')
        return this.operation(operation, () => this.makePlacementOptions(plan))
      case 'listPlacementOptions':
        return this.json(200, { placementOptions: plan.placementOptions, pagination: {} })
      case 'confirmPlacementOption': {
        const option = plan.placementOptions.find(o => o.placementOptionId === second)
        if (!option) return this.error(400, 'BadRequest', 'The requested placementOptionId does not exist for the given inbound plan.')
        return this.operation(operation, () => this.confirmPlacement(plan, option))
      }
      case 'getShipment': {
        const shipment = plan.shipments.get(second)
        if (!shipment) return this.error(400, 'BadRequest', 'The requested shipmentId does not exist for the specified inbound plan.')
        return this.json(200, this.shipmentAnswer(plan, shipment))
      }
      case 'listShipmentItems': {
        const shipment = plan.shipments.get(second)
        if (!shipment) return this.error(400, 'BadRequest', 'The requested shipmentId does not exist for the specified inbound plan.')
        const byMsku = new Map<string, number>()
        for (const box of shipment.boxes) for (const item of box.items) byMsku.set(item.msku, (byMsku.get(item.msku) ?? 0) + item.quantity)
        return this.json(200, { items: [...byMsku].map(([msku, quantity]) => ({ msku, quantity, asin: `ASIN-${msku}`, fnsku: `X00${msku}`, labelOwner: 'SELLER', prepInstructions: [] })), pagination: {} })
      }
      case 'listShipmentBoxes': {
        const shipment = plan.shipments.get(second)
        if (!shipment) return this.error(400, 'BadRequest', 'The requested shipmentId does not exist for the specified inbound plan.')
        const template = fx.eu.box
        return this.json(200, {
          boxes: shipment.boxes.map(b => ({
            ...clone(template), packageId: b.packageId, boxId: shipment.selectedTransportationOptionId ? b.boxId : undefined,
            quantity: 1, dimensions: b.dims, weight: b.weight, items: b.items.map(i => ({ ...clone(template.items[0]), msku: i.msku, quantity: i.quantity })),
            destinationRegion: { countryCode: 'IT', warehouseId: shipment.warehouseId },
          })),
          pagination: {},
        })
      }
      case 'generateTransportationOptions': {
        const option = plan.placementOptions.find(o => o.placementOptionId === body.placementOptionId)
        if (!option) return this.error(400, 'BadRequest', 'The requested placementOptionId does not exist for the given inbound plan.')
        for (const config of body.shipmentTransportationConfigurations) {
          if (!option.shipmentIds.includes(config.shipmentId)) return this.error(400, 'BadRequest', 'The requested shipmentId does not exist under the provided placement option.')
        }
        return this.operation(operation, () => {
          for (const config of body.shipmentTransportationConfigurations) this.makeTransportOptions(plan.shipments.get(config.shipmentId)!)
        })
      }
      case 'listTransportationOptions': {
        let list = [...plan.shipments.values()]
        if (query.placementOptionId) list = list.filter(s => s.placementOptionId === query.placementOptionId)
        if (query.shipmentId) list = list.filter(s => s.shipmentId === query.shipmentId)
        return this.json(200, { transportationOptions: list.flatMap(s => s.transportOptions), pagination: {} })
      }
      case 'confirmTransportationOptions':
        for (const selection of body.transportationSelections) {
          const shipment = plan.shipments.get(selection.shipmentId)
          if (!shipment?.transportOptions.some(o => o.transportationOptionId === selection.transportationOptionId)) {
            return this.error(400, 'BadRequest', 'The requested transportationOptionId does not exist under the associated shipment.')
          }
        }
        return this.operation(operation, () => {
          for (const selection of body.transportationSelections) plan.shipments.get(selection.shipmentId)!.selectedTransportationOptionId = selection.transportationOptionId
        })
      case 'generateDeliveryWindowOptions': {
        const shipment = plan.shipments.get(second)
        if (!shipment) return this.error(400, 'BadRequest', 'The provided shipmentId is not valid for the specified inbound plan.')
        return this.operation(operation, () => this.makeDeliveryWindows(shipment))
      }
      case 'listDeliveryWindowOptions': {
        const shipment = plan.shipments.get(second)
        if (!shipment) return this.error(400, 'BadRequest', 'The provided shipmentId is not valid for the specified inbound plan.')
        return this.json(200, { deliveryWindowOptions: shipment.deliveryWindows, pagination: {} })
      }
      case 'confirmDeliveryWindowOptions': {
        const shipment = plan.shipments.get(second)
        if (!shipment) return this.error(400, 'BadRequest', 'The requested shipmentId does not exist under the associated inbound plan.')
        if (!shipment.deliveryWindows.some(w => w.deliveryWindowOptionId === third)) return this.error(400, 'BadRequest', 'The requested deliveryWindowOptionId does not exist.')
        return this.operation(operation, () => { shipment.selectedDeliveryWindowId = third })
      }
      case 'updateShipmentTrackingDetails': {
        const shipment = plan.shipments.get(second)
        if (!shipment) return this.error(400, 'BadRequest', 'The requested shipmentId does not exist for the specified inbound plan.')
        const items = body.trackingDetails?.spdTrackingDetail?.spdTrackingItems ?? []
        const known = new Set(shipment.boxes.map(b => b.boxId))
        const unknown = items.find((i: any) => !known.has(i.boxId))
        if (unknown) return this.error(400, 'BadRequest', `The box ${unknown.boxId} is not in this shipment.`)
        return this.operation(operation, () => { shipment.tracking = clone(items) })
      }
      default:
        return this.error(404, 'NotFound', `The fake has no ${operation}`)
    }
  }

  /** The best option has `packingGroups` groups (SKUs dealt round-robin) and no fee; a worse one has one more group and a fee. */
  private makePackingOptions(plan: FakePlan): void {
    const fx = inboundFixture()
    plan.packingGroups.clear()
    const make = (groups: number, fee: number) => {
      const ids = Array.from({ length: Math.max(1, Math.min(groups, plan.items.length)) }, () => this.next('pg'))
      ids.forEach(id => plan.packingGroups.set(id, []))
      plan.items.forEach((item, i) => plan.packingGroups.get(ids[i % ids.length])!.push({ msku: item.msku, quantity: item.quantity }))
      const option = clone(fx.eu.packingOption)
      option.packingOptionId = this.next('po')
      option.packingGroups = ids
      option.status = 'OFFERED'
      option.expiration = this.iso(3 * 86_400_000)
      option.fees = option.fees.map((f: any) => ({ ...f, value: { code: 'EUR', amount: fee } }))
      return option
    }
    const groups = this.script.packingGroups ?? 1
    plan.packingOptions = [make(groups + 1, 12.5), make(groups, 0)]
  }

  /** Two options by default: everything to the first FC; then split over two FCs. Boxes come from setPackingInformation. */
  private makePlacementOptions(plan: FakePlan): void {
    const fx = inboundFixture()
    for (const option of plan.placementOptions) if (option.status === 'OFFERED') option.status = 'EXPIRED'
    const counts = fx.eu.placementShipmentCounts.slice(0, Math.max(1, this.script.placements ?? fx.eu.placementShipmentCounts.length))
    for (const count of counts) {
      const option = clone(fx.eu.placementOption)
      option.placementOptionId = this.next('pl')
      option.status = 'OFFERED'
      option.expiration = this.iso(3 * 86_400_000)
      option.shipmentIds = []
      const centres = fx.eu.fulfilmentCentres.slice(0, count)
      const physical = (plan.packingInfo?.packageGroupings ?? []).flatMap((g: any) => g.boxes.flatMap((b: any) => Array.from({ length: b.quantity }, () => b)))
      centres.forEach((centre, index) => {
        const shipmentId = this.next('sh')
        option.shipmentIds.push(shipmentId)
        const mine = physical.filter((_: unknown, i: number) => i % centres.length === index)
        plan.shipments.set(shipmentId, {
          shipmentId, placementOptionId: option.placementOptionId, warehouseId: centre.warehouseId, city: centre.city, confirmationId: null,
          transportOptions: [], deliveryWindows: [], selectedTransportationOptionId: null, selectedDeliveryWindowId: null, tracking: null,
          boxes: mine.map((b: any) => ({ boxId: '', packageId: this.next('pk'), dims: clone(b.dimensions), weight: clone(b.weight), items: (b.items ?? []).map((i: any) => ({ msku: i.msku, quantity: i.quantity })) })),
        })
      })
      plan.placementOptions.push(option)
    }
  }

  private confirmPlacement(plan: FakePlan, chosen: any): void {
    for (const option of plan.placementOptions) option.status = option.placementOptionId === chosen.placementOptionId ? 'ACCEPTED' : 'EXPIRED'
    for (const shipmentId of chosen.shipmentIds) {
      const shipment = plan.shipments.get(shipmentId)!
      this.counter += 1
      shipment.confirmationId = `FBA15${this.seed.slice(0, 3).toUpperCase()}${String(this.counter).padStart(4, '0')}`
      shipment.boxes.forEach((box, i) => { box.boxId = `${shipment.confirmationId}U${String(i + 1).padStart(6, '0')}` })
    }
  }

  private makeTransportOptions(shipment: FakeShipment): void {
    const fx = inboundFixture()
    const own = { ...clone(fx.eu.transportationOptions.ownCarrier), shipmentId: shipment.shipmentId, transportationOptionId: this.next('to') }
    const options = [own]
    if (this.script.partnered) {
      const partnered = clone(fx.eu.transportationOptions.partnered)
      partnered.shipmentId = shipment.shipmentId
      partnered.transportationOptionId = this.next('to')
      partnered.quote.expiration = this.iso(86_400_000)
      partnered.quote.voidableUntil = this.iso(86_400_000)
      options.push(partnered)
    }
    shipment.transportOptions = options
  }

  private makeDeliveryWindows(shipment: FakeShipment): void {
    const fx = inboundFixture()
    const day = 86_400_000
    shipment.deliveryWindows = [3, 5].map(start => ({
      ...clone(fx.eu.deliveryWindowOption), deliveryWindowOptionId: this.next('dw'),
      startDate: this.iso(start * day), endDate: this.iso((start + 7) * day), validUntil: this.iso(3 * day), availabilityType: 'AVAILABLE',
    }))
  }

  private shipmentAnswer(plan: FakePlan, shipment: FakeShipment): any {
    const fx = inboundFixture()
    const answer = clone(fx.eu.shipment)
    const centre = fx.eu.fulfilmentCentres.find(c => c.warehouseId === shipment.warehouseId)!
    answer.shipmentId = shipment.shipmentId
    answer.placementOptionId = shipment.placementOptionId
    answer.name = `${plan.name}-${shipment.warehouseId}`
    answer.destination.warehouseId = shipment.warehouseId
    answer.destination.address = { ...answer.destination.address, city: centre.city, stateOrProvinceCode: centre.stateOrProvinceCode, postalCode: centre.postalCode }
    answer.source.address = clone(plan.sourceAddress)
    answer.status = shipment.tracking ? 'SHIPPED' : 'WORKING'
    if (shipment.confirmationId) answer.shipmentConfirmationId = shipment.confirmationId
    else delete answer.shipmentConfirmationId
    if (shipment.selectedTransportationOptionId) answer.selectedTransportationOptionId = shipment.selectedTransportationOptionId
    else delete answer.selectedTransportationOptionId
    const window = shipment.deliveryWindows.find(w => w.deliveryWindowOptionId === shipment.selectedDeliveryWindowId)
    if (window) answer.selectedDeliveryWindow = { ...answer.selectedDeliveryWindow, deliveryWindowOptionId: window.deliveryWindowOptionId, startDate: window.startDate, endDate: window.endDate }
    else delete answer.selectedDeliveryWindow
    if (shipment.tracking) answer.trackingDetails = { spdTrackingDetail: { spdTrackingItems: shipment.tracking.map(t => ({ ...t, trackingNumberValidationStatus: 'VALIDATED' })) } }
    else delete answer.trackingDetails
    return answer
  }
}

let shared: FakeAmazon | null = null
/** The one fake Amazon of this process (the private stack): its plans live as long as the process. */
export function sharedFakeAmazon(): FakeAmazon {
  shared ??= new FakeAmazon()
  return shared
}
