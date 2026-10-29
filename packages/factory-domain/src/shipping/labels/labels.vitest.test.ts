import { describe, expect, it } from 'vitest'
import { FACTORY_PERMISSIONS } from '../../auth/permissions/catalogue'
import { ROLE_TEMPLATES } from '../../auth/roles/templates'
import { EVENT_CATALOGUE } from '../../events/catalogue'
import { labelledParcelProblems, parcelChangeProblems } from '../shipments'
import {
  accountProblems,
  buyFieldProblems,
  buyStateProblems,
  cutOffOf,
  externalReferenceOf,
  labelFileName,
  labelFormatsFor,
  labelRequestOf,
  parcelsToLabel,
  partialProblem,
  voidProblems,
  type LabelAccount,
  type LabelFacts,
  type LabelParcel,
} from './labels'
import { pollDue, statusOfSendcloudCode, statusOfSendcloudId, trackingMoveOf, trackingNews, type TrackingFact } from './tracking'

const COMPANY = '0190a0a0-0000-7000-8000-000000000001'
const account = (fields: Partial<LabelAccount> = {}): LabelAccount => ({ id: 'acc', provider: 'SENDCLOUD', companyId: COMPANY, mode: 'FAKE', status: 'ACTIVE', ...fields })
const parcel = (seq: number, fields: Partial<LabelParcel> = {}): LabelParcel => ({
  id: `p${seq}`,
  seq,
  version: 1,
  grossWeightKg: '1.8500',
  lengthCm: null,
  widthCm: null,
  heightCm: null,
  trackingNumber: null,
  providerId: null,
  ...fields,
})
const address = { name: 'Made-up Workshop', line1: 'Via Esempio 12', postalCode: '00000', city: 'Seedville', province: 'MI', country: 'IT' }
const facts = (fields: Partial<LabelFacts> = {}, shipment: Partial<LabelFacts['shipment']> = {}): LabelFacts => ({
  shipment: { number: 'SH-00002', status: 'PACKED', transportBy: 'CARRIER', companyId: COMPANY, shipTo: address, carrierCode: 'brt', serviceCode: 'brt:standard', ...shipment },
  sender: { ...address, name: 'Made-up Factory S.r.l.' },
  liveDdtNumber: '145/2026',
  parcels: [parcel(1), parcel(2)],
  account: account(),
  environment: 'test',
  ...fields,
})

describe('buying labels (LOG-025, LOG-032; Owner Q20)', () => {
  it('needs a PACKED shipment carried by a carrier, a live DDT and the company own usable Sendcloud account', () => {
    expect(buyStateProblems(facts())).toEqual([])
    const messages = (input: LabelFacts) => buyStateProblems(input).map((problem) => problem.message)
    expect(messages(facts({}, { status: 'DRAFT' }))).toEqual([expect.stringContaining('carrier labels are bought while it is PACKED')])
    expect(messages(facts({}, { transportBy: 'SENDER' }))).toEqual([expect.stringContaining('no carrier label is needed')])
    expect(messages(facts({ liveDdtNumber: null }))).toEqual([expect.stringContaining('issue the DDT first')])
    expect(messages(facts({ account: null }))).toEqual([expect.stringContaining("only through the company's own Sendcloud account")])
  })

  it('refuses another company, a tenant-wide account, another provider, FAKE outside local and test, a paused or disabled account', () => {
    expect(accountProblems(account({ companyId: null }), COMPANY, 'test')[0]?.message).toContain("not this company's own")
    expect(accountProblems(account({ companyId: 'other' }), COMPANY, 'test')[0]?.message).toContain("not this company's own")
    expect(accountProblems(account({ provider: 'SDI' }), COMPANY, 'test')[0]?.message).toContain('not a Sendcloud account')
    expect(accountProblems(account(), COMPANY, 'production')[0]?.message).toContain('FAKE works in local and test only')
    expect(accountProblems(account(), COMPANY, 'staging')).toHaveLength(1)
    expect(accountProblems(account({ mode: 'LIVE' }), COMPANY, 'production')).toEqual([])
    expect(accountProblems(account({ status: 'PAUSED' }), COMPANY, 'test')[0]?.message).toContain('kill switch')
    expect(accountProblems(account({ status: 'DISABLED' }), COMPANY, 'test')[0]?.message).toContain('disabled')
  })

  it('names every missing field: sender, recipient, service, each parcel weight, sizes all or none', () => {
    expect(buyFieldProblems(facts())).toEqual([])
    const problems = buyFieldProblems(
      facts({ sender: null, parcels: [parcel(1, { grossWeightKg: null }), parcel(2, { lengthCm: '40.00' })] }, { serviceCode: null, shipTo: { ...address, city: '' } }),
    )
    expect(problems.map((problem) => problem.path)).toEqual(['settings/senderAddress', 'shipment/shipTo/city', 'shipment/serviceCode', 'parcels/1/grossWeightKg', 'parcels/2'])
  })

  it('labels only parcels without one; one request per parcel with a reference of the parcel and its version', () => {
    const labelled = parcel(1, { trackingNumber: 'FK1', providerId: 'x:1' })
    expect(parcelsToLabel([parcel(3), labelled, parcel(2)]).map((entry) => entry.seq)).toEqual([2, 3])
    expect(externalReferenceOf({ id: 'p2', version: 4 })).toBe('p2.v4')
    const request = labelRequestOf(facts(), parcel(2, { lengthCm: '40.00', widthCm: '30.00', heightCm: '10.00' }))
    expect(request).toMatchObject({ shipmentNumber: 'SH-00002', seq: 2, parcels: 2, externalReference: 'p2.v1', serviceCode: 'brt:standard', weightKg: '1.8500', lengthCm: '40.00' })
    expect(request.from).toMatchObject({ name: 'Made-up Factory S.r.l.', country: 'IT', phone: null })
    expect(request.to).toMatchObject({ name: 'Made-up Workshop', city: 'Seedville' })
  })

  it('keeps the PDF always and ZPL with a label printer; names the files', () => {
    expect(labelFormatsFor(null)).toEqual(['PDF'])
    expect(labelFormatsFor('A4_PDF')).toEqual(['PDF'])
    expect(labelFormatsFor('LABEL_ZPL')).toEqual(['PDF', 'ZPL'])
    expect(labelFileName('SH 0002', 1, 'FK/12', 'ZPL')).toBe('label-SH-0002-1-FK-12.zpl')
  })

  it('says a partial buy plainly', () => {
    expect(partialProblem([{ parcelId: 'a', seq: 1, ok: true }])).toBeNull()
    expect(partialProblem([{ parcelId: 'a', seq: 1, ok: true }, { parcelId: 'b', seq: 2, ok: false, problem: 'x' }])).toBe(
      '1 of 2 labels were bought; parcel 2 still need one: see each parcel\'s problem, then buy again (the labels bought are kept).',
    )
    expect(partialProblem([{ parcelId: 'b', seq: 2, ok: false, problem: 'x' }])).toContain('No label was bought (parcel 2)')
  })

  it('voids only a label of a shipment that has not left', () => {
    const labelled = { seq: 1, trackingNumber: 'FK1', providerId: 'x:1' }
    expect(voidProblems('PACKED', labelled)).toEqual([])
    expect(voidProblems('SHIPPED', labelled)).toEqual(['The shipment is SHIPPED; a label is voided only before the goods leave.'])
    expect(voidProblems('PACKED', { seq: 2, trackingNumber: null, providerId: null })).toEqual(['Parcel 2 has no carrier label.'])
  })

  it('a labelled parcel keeps its weight, sizes and contents until its label is voided', () => {
    expect(labelledParcelProblems({ seq: 2, labelled: true })).toEqual(['Parcel 2 has a carrier label: void the label first (it was bought for this weight, size and contents).'])
    expect(labelledParcelProblems({ seq: 2, labelled: false })).toEqual([])
    expect(parcelChangeProblems('PACKED', { grossWeightKg: '2' }, { seq: 1, labelled: true })).toEqual([expect.stringContaining('void the label first')])
    expect(parcelChangeProblems('PACKED', { grossWeightKg: '2' }, { seq: 1, labelled: false })).toEqual([])
  })

  it('gives the cut-off of the day in Rome', () => {
    const cut = cutOffOf('16:00', new Date('2026-10-29T14:30:00.000Z'))
    expect(cut).toEqual({ time: '16:00', at: new Date('2026-10-29T15:00:00.000Z'), passed: false })
    expect(cutOffOf('16:00', new Date('2026-10-29T15:00:00.000Z'))?.passed).toBe(true)
    expect(cutOffOf(null, new Date())).toBeNull()
  })
})

describe('tracking (LOG-059)', () => {
  it("maps Sendcloud's webhook statuses, unknown ones by their words, and ignores a label's own cancellation", () => {
    expect(statusOfSendcloudId(11, 'Delivered')).toBe('DELIVERED')
    expect(statusOfSendcloudId(62993, 'Returned to sender')).toBe('RETURNED')
    expect(statusOfSendcloudId(92, 'Driver en route')).toBe('OUT_FOR_DELIVERY')
    expect(statusOfSendcloudId(8, 'Delivery attempt failed')).toBe('EXCEPTION')
    expect(statusOfSendcloudId(1000, 'Ready to send')).toBe('LABEL_CREATED')
    expect(statusOfSendcloudId(2000, 'Cancelled')).toBeNull()
    expect(statusOfSendcloudId(77777, 'Returned to the depot')).toBe('RETURNED')
    expect(statusOfSendcloudId(77778, 'Parcel at hub')).toBe('IN_TRANSIT')
    expect(statusOfSendcloudId(77779, null)).toBe('EXCEPTION')
  })

  it('maps the v3 tracking phases and exceptions', () => {
    expect(statusOfSendcloudCode('delivered')).toBe('DELIVERED')
    expect(statusOfSendcloudCode('in_delivery')).toBe('OUT_FOR_DELIVERY')
    expect(statusOfSendcloudCode('no_label')).toBeNull()
    expect(statusOfSendcloudCode('exception:returned_sender')).toBe('RETURNED')
    expect(statusOfSendcloudCode('exception:cancelled')).toBeNull()
    expect(statusOfSendcloudCode('exception:delivery_delay')).toBe('EXCEPTION')
    expect(statusOfSendcloudCode('something_new')).toBe('EXCEPTION')
  })

  it('records an event once: its id, or the same status of a parcel from the other source within hours', () => {
    const at = new Date('2026-10-29T10:00:00.000Z')
    const recorded: TrackingFact[] = [{ parcelId: 'p1', status: 'DELIVERED', source: 'POLL', occurredAt: at, externalEventId: 'sc3:1' }]
    const webhook = (fields: Partial<TrackingFact>): TrackingFact => ({ parcelId: 'p1', status: 'DELIVERED', source: 'WEBHOOK', occurredAt: new Date(at.getTime() + 60_000), externalEventId: 'w:1', ...fields })
    expect(trackingNews(recorded, webhook({ externalEventId: 'sc3:1' }))).toBe('duplicate')
    expect(trackingNews(recorded, webhook({}))).toBe('duplicate')
    expect(trackingNews(recorded, webhook({ occurredAt: new Date(at.getTime() + 7 * 3_600_000) }))).toBe('record')
    expect(trackingNews(recorded, webhook({ source: 'POLL', externalEventId: 'sc3:2' }))).toBe('record')
    expect(trackingNews(recorded, webhook({ parcelId: 'p2' }))).toBe('record')
    expect(trackingNews(recorded, webhook({ status: 'EXCEPTION' }))).toBe('record')
  })

  it('moves a SHIPPED shipment when every tracked parcel arrived, or came back; mixed and PACKED wait', () => {
    const parcels = [
      { id: 'p1', seq: 1 },
      { id: 'p2', seq: 2 },
    ]
    const latest = (a: string | undefined, b: string | undefined) => new Map(Object.entries({ p1: a, p2: b }).filter(([, value]) => value !== undefined)) as Map<string, 'DELIVERED'>
    expect(trackingMoveOf('SHIPPED', parcels, latest('DELIVERED', 'DELIVERED'))).toEqual({ kind: 'move', to: 'DELIVERED' })
    expect(trackingMoveOf('SHIPPED', parcels, latest('RETURNED', 'RETURNED'))).toEqual({ kind: 'move', to: 'RETURNED' })
    expect(trackingMoveOf('SHIPPED', parcels, latest('DELIVERED', 'IN_TRANSIT'))).toEqual({ kind: 'none' })
    expect(trackingMoveOf('SHIPPED', parcels, latest('DELIVERED', undefined))).toEqual({ kind: 'none' })
    expect(trackingMoveOf('SHIPPED', parcels, latest('DELIVERED', 'RETURNED'))).toMatchObject({ kind: 'mixed', problem: expect.stringContaining('parcel 2 returned') })
    expect(trackingMoveOf('PACKED', parcels, latest('DELIVERED', 'DELIVERED'))).toMatchObject({ kind: 'waits' })
    expect(trackingMoveOf('DELIVERED', parcels, latest('DELIVERED', 'DELIVERED'))).toEqual({ kind: 'none' })
    expect(trackingMoveOf('SHIPPED', [], new Map())).toEqual({ kind: 'none' })
  })

  it('polls a silent parcel every 12 hours of silence, never a delivered or returned one', () => {
    const labelledAt = new Date('2026-10-29T00:00:00.000Z')
    const hours = (n: number) => new Date(labelledAt.getTime() + n * 3_600_000 + 17 * 60_000)
    expect(pollDue({ labelledAt, latest: null }, hours(11))).toBe(false)
    expect(pollDue({ labelledAt, latest: null }, hours(12))).toBe(true)
    expect(pollDue({ labelledAt, latest: null }, hours(13))).toBe(false)
    expect(pollDue({ labelledAt, latest: null }, hours(24))).toBe(true)
    expect(pollDue({ labelledAt, latest: { status: 'IN_TRANSIT', recordedAt: hours(10) } }, hours(22))).toBe(true)
    expect(pollDue({ labelledAt, latest: { status: 'DELIVERED', recordedAt: labelledAt } }, hours(24))).toBe(false)
    expect(pollDue({ labelledAt: null, latest: null }, hours(24))).toBe(false)
  })
})

describe('declarations', () => {
  it('declares the label permissions (write: buying spends money) and gives them to the warehouse, never to a floor role', () => {
    expect(FACTORY_PERMISSIONS.get('shipping.labels.buy')).toMatchObject({ risk: 'write' })
    expect(FACTORY_PERMISSIONS.get('shipping.labels.void')).toMatchObject({ risk: 'write' })
    const warehouse = ROLE_TEMPLATES.find((role) => role.key === 'warehouse')!
    expect(warehouse.permissions).toEqual(expect.arrayContaining(['shipping.labels.buy', 'shipping.labels.void']))
    for (const role of ROLE_TEMPLATES.filter((entry) => entry.audience === 'floor')) expect(role.permissions).not.toContain('shipping.labels.buy')
  })

  it('declares the label and tracking events', () => {
    for (const type of ['shipment.labels_bought', 'shipment.label_voided', 'shipment.tracking_recorded', 'shipment.tracking_poll_due']) expect(EVENT_CATALOGUE.find(type, 1)).toBeDefined()
  })
})
