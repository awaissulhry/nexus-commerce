#!/usr/bin/env node
/**
 * Step 4 Send to FBA — the recorded Amazon answers for the FBA Inbound v2024-03-20 client, the runner and the fake
 * Amazon (`src/services/fba-inbound/fake-amazon.ts`). Nothing here calls Amazon or any network: it reads a LOCAL copy of
 * Amazon's published model and writes `src/services/fba-inbound/__fixtures__/amazon-inbound-2024-03-20.json`:
 *
 *   source      the model's URL, the commit date it was taken at, and the sha256 of the file read
 *   operations  per operation the client uses: method, path, body definition, and every `x-amzn-api-sandbox.static`
 *               request/answer pair of the model (Amazon's own examples), request split into path / query / body
 *   schemas     required fields, nested definitions and enums of the request bodies the client builds — the fake
 *               refuses a body that misses one (400, as Amazon would), so tests check every body against the model
 *   v0          getLabels (v0, still live): the GetLabelsResponse shape, hand-written (the v0 model is not read here)
 *   eu          EU-adjusted answers the fake serves (amazon.it, EUR, CM/KG, own carrier, two placement options, one
 *               FAILED operation) — copies of Amazon's examples with the values changed, never new shapes
 *
 * Get the model (any way you like; this script never downloads):
 *   https://raw.githubusercontent.com/amzn/selling-partner-api-models/main/models/fulfillment-inbound-api-model/fulfillmentInbound_2024-03-20.json
 *
 * Run from apps/api:
 *   node scripts/fba-inbound-fixtures.mjs --model <path to fulfillmentInbound_2024-03-20.json>          # write
 *   node scripts/fba-inbound-fixtures.mjs --model <path> --check                                          # exit 1 when the file differs
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = resolve(HERE, '../src/services/fba-inbound/__fixtures__/amazon-inbound-2024-03-20.json')
const MODEL_URL = 'https://github.com/amzn/selling-partner-api-models/blob/main/models/fulfillment-inbound-api-model/fulfillmentInbound_2024-03-20.json'
/** The model's last commit when it was read for Step 4 (research note 5-web-research.md, 2026-10-07). */
const MODEL_COMMIT_DATE = '2026-08-21'

/** The operations the client wraps (apps/api/src/clients/amazon-fba-inbound-v2.client.ts). */
const OPERATIONS = [
  'listInboundPlans', 'createInboundPlan', 'getInboundOperationStatus', 'cancelInboundPlan',
  'generatePackingOptions', 'listPackingOptions', 'listPackingGroupItems', 'confirmPackingOption', 'setPackingInformation',
  'generatePlacementOptions', 'listPlacementOptions', 'confirmPlacementOption',
  'getShipment', 'listShipmentItems', 'listShipmentBoxes',
  'generateTransportationOptions', 'listTransportationOptions', 'confirmTransportationOptions',
  'generateDeliveryWindowOptions', 'listDeliveryWindowOptions', 'confirmDeliveryWindowOptions',
  'updateShipmentTrackingDetails',
]

const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const value = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }
const modelPath = value('--model')
if (!modelPath) {
  console.error(`usage: node scripts/fba-inbound-fixtures.mjs --model <path> [--check]\n  model: ${MODEL_URL}`)
  process.exit(2)
}
const raw = readFileSync(resolve(process.cwd(), modelPath))
const model = JSON.parse(raw.toString('utf8'))
if (model?.info?.version !== '2024-03-20') {
  console.error(`not the FBA Inbound 2024-03-20 model (info.version = ${model?.info?.version})`)
  process.exit(2)
}

const clone = (v) => JSON.parse(JSON.stringify(v))
const refName = (ref) => (typeof ref === 'string' ? ref.replace('#/definitions/', '') : null)

/* ── operations: method, path, body definition, Amazon's sandbox pairs ───────────────────────────────── */
const operations = {}
for (const [path, item] of Object.entries(model.paths)) {
  for (const [method, op] of Object.entries(item)) {
    if (!['get', 'post', 'put', 'delete'].includes(method) || !OPERATIONS.includes(op.operationId)) continue
    const params = [...(item.parameters ?? []), ...(op.parameters ?? [])]
    const where = Object.fromEntries(params.map(p => [p.name, p.in]))
    const bodyParam = params.find(p => p.in === 'body')
    const examples = []
    for (const [status, response] of Object.entries(op.responses ?? {})) {
      for (const pair of response['x-amzn-api-sandbox']?.static ?? []) {
        const request = { path: {}, query: {}, body: null }
        for (const [name, wrapped] of Object.entries(pair.request?.parameters ?? {})) {
          const v = wrapped?.value
          if (where[name] === 'body') request.body = v
          else if (where[name] === 'query') request.query[name] = v
          else request.path[name] = v
        }
        examples.push({ status: Number(status), request, response: pair.response ?? null })
      }
    }
    operations[op.operationId] = {
      method: method.toUpperCase(),
      path,
      body: bodyParam ? refName(bodyParam.schema?.$ref) : null,
      query: params.filter(p => p.in === 'query').map(p => p.name),
      examples,
    }
  }
}
const missing = OPERATIONS.filter(name => !operations[name])
if (missing.length) {
  console.error(`the model has no ${missing.join(', ')}`)
  process.exit(1)
}
const orderedOperations = Object.fromEntries(OPERATIONS.map(name => [name, operations[name]]))

/* ── schemas: required fields, nested definitions, enums of the request bodies ───────────────────────── */
const schemas = {}
function collect(name) {
  if (!name || schemas[name]) return
  const def = model.definitions[name]
  if (!def || def.type !== 'object') return
  const entry = { required: [...(def.required ?? [])].sort(), refs: {}, enums: {} }
  schemas[name] = entry
  for (const [prop, spec] of Object.entries(def.properties ?? {})) {
    const direct = refName(spec.$ref)
    const inner = refName(spec.items?.$ref)
    const target = direct ?? inner
    const targetDef = target ? model.definitions[target] : null
    if (targetDef?.enum) entry.enums[prop] = [...targetDef.enum]
    else if (spec.enum) entry.enums[prop] = [...spec.enum]
    else if (targetDef?.type === 'object') {
      entry.refs[prop] = { def: target, array: !!inner }
      collect(target)
    }
  }
}
for (const op of Object.values(orderedOperations)) collect(op.body)
const orderedSchemas = Object.fromEntries(Object.keys(schemas).sort().map(k => [k, schemas[k]]))

/* ── v0 getLabels (still live; the v2024 model has no labels call) ────────────────────────────────────── */
const v0 = {
  getLabels: {
    method: 'GET',
    path: '/fba/inbound/v0/shipments/{shipmentId}/labels',
    source: 'Hand-written from the v0 model (GetLabelsResponse → payload: LabelDownloadURL { DownloadURL }); not an Amazon sandbox pair.',
    request: {
      path: { shipmentId: 'FBA1234ABCD' },
      query: { PageType: 'PackageLabel_A4_4', LabelType: 'UNIQUE', PackageLabelsToPrint: 'FBA1234ABCDU000001,FBA1234ABCDU000002' },
    },
    response: { payload: { DownloadURL: 'https://example.com/fba-inbound/labels/FBA1234ABCD.pdf' } },
  },
}

/* ── EU-adjusted answers (copies of Amazon's examples with the values changed) ───────────────────────── */
const AMAZON_IT = 'APJ6JRA9NG5V4'
const example = (op, status) => {
  const found = orderedOperations[op].examples.find(e => e.status === status)
  if (!found) throw new Error(`no ${status} example for ${op}`)
  return clone(found.response)
}
const euMoney = (amount) => ({ code: 'EUR', amount })

const packingOption = example('listPackingOptions', 200).packingOptions[0]
packingOption.fees = packingOption.fees.map(f => ({ ...f, value: euMoney(0) }))
packingOption.discounts = []
packingOption.supportedShippingConfigurations = [
  { shippingSolution: 'USE_YOUR_OWN_CARRIER', shippingMode: 'GROUND_SMALL_PARCEL' },
  { shippingSolution: 'AMAZON_PARTNERED_CARRIER', shippingMode: 'GROUND_SMALL_PARCEL' },
]
packingOption.supportedConfigurations = packingOption.supportedConfigurations.map(c => ({
  ...c, boxRequirements: { weight: { unit: 'KG', minimum: 0.15, maximum: 23 } },
}))

const placementOption = example('listPlacementOptions', 200).placementOptions[0]
placementOption.fees = placementOption.fees.map(f => ({ ...f, value: euMoney(0) }))
placementOption.discounts = []

const shipment = example('getShipment', 200)
shipment.destination.warehouseId = 'MXP5'
shipment.destination.address = { ...shipment.destination.address, name: 'Amazon MXP5', companyName: 'Amazon', city: 'Castel San Giovanni', countryCode: 'IT', stateOrProvinceCode: 'PC', postalCode: '29015' }
shipment.source.address = { name: 'Test Sender', companyName: 'Test Company', addressLine1: 'Via Prova 1', city: 'Testville', countryCode: 'IT', postalCode: '00000', phoneNumber: '+390000000000', email: 'ship@example.test' }
shipment.freightInformation = { freightClass: 'FC_50', declaredValue: euMoney(500) }
delete shipment.selfShipAppointmentDetails
delete shipment.trackingDetails?.ltlTrackingDetail

const transport = example('listTransportationOptions', 200).transportationOptions[0]
const ownCarrier = { ...clone(transport), shippingSolution: 'USE_YOUR_OWN_CARRIER', carrier: { name: 'UPS', alphaCode: 'UPSN' }, preconditions: ['CONFIRMED_DELIVERY_WINDOW'] }
delete ownCarrier.quote
delete ownCarrier.carrierAppointment
const partnered = { ...clone(transport), carrier: { name: 'UPS', alphaCode: 'UPSN' }, quote: { ...transport.quote, cost: euMoney(24.5) }, preconditions: [] }
delete partnered.carrierAppointment

const deliveryWindow = example('listDeliveryWindowOptions', 200).deliveryWindowOptions[0]
const failedOperation = example('getInboundOperationStatus', 200)
failedOperation.operation = 'generatePlacementOptions'
failedOperation.operationStatus = 'FAILED'
failedOperation.operationProblems = failedOperation.operationProblems.map(p => ({ ...p, severity: 'ERROR' }))

const box = example('listShipmentBoxes', 200).boxes[0]
box.quantity = 1
box.destinationRegion = { countryCode: 'IT', warehouseId: 'MXP5' }
delete box.externalContainerIdentifier
delete box.externalContainerIdentifierType

const eu = {
  note: 'Amazon\'s examples with EU values: amazon.it, EUR, CM/KG, own carrier first, two placement options (1 shipment to MXP5; 2 shipments to MXP5 + FCO1), one FAILED operation. Shapes unchanged.',
  marketplaceId: AMAZON_IT,
  currency: 'EUR',
  fulfilmentCentres: [
    { warehouseId: 'MXP5', city: 'Castel San Giovanni', stateOrProvinceCode: 'PC', postalCode: '29015' },
    { warehouseId: 'FCO1', city: 'Passo Corese', stateOrProvinceCode: 'RI', postalCode: '02032' },
  ],
  packingOption,
  placementOption,
  placementShipmentCounts: [1, 2],
  shipment,
  transportationOptions: { ownCarrier, partnered },
  deliveryWindowOption: deliveryWindow,
  box,
  failedOperation,
}

const fixture = {
  source: {
    model: MODEL_URL,
    commitDate: MODEL_COMMIT_DATE,
    sha256: createHash('sha256').update(raw).digest('hex'),
    extractedBy: 'apps/api/scripts/fba-inbound-fixtures.mjs',
  },
  operations: orderedOperations,
  schemas: orderedSchemas,
  v0,
  eu,
}
const text = `${JSON.stringify(fixture, null, 2)}\n`

if (flag('--check')) {
  let current = ''
  try { current = readFileSync(OUT, 'utf8') } catch { /* absent */ }
  if (current !== text) {
    console.error(`❌ ${OUT} differs from the model's answers — run without --check to write it`)
    process.exit(1)
  }
  console.log(`✅ ${OUT} matches (${OPERATIONS.length} operations, ${Object.keys(orderedSchemas).length} body definitions)`)
} else {
  mkdirSync(dirname(OUT), { recursive: true })
  writeFileSync(OUT, text)
  const pairs = Object.values(orderedOperations).reduce((n, op) => n + op.examples.length, 0)
  console.log(`wrote ${OUT}: ${OPERATIONS.length} operations, ${pairs} Amazon example pairs, ${Object.keys(orderedSchemas).length} body definitions`)
}
