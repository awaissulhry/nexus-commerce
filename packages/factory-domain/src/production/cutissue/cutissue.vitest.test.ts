import { describe, expect, it } from 'vitest'
import { FACTORY_PERMISSIONS, FLOOR_SHARED_PERMISSIONS } from '../../auth/permissions/catalogue'
import { templateOf } from '../../auth/roles/templates'
import { EVENT_CATALOGUE } from '../../events/catalogue'
import { QUEUED_ACTIONS } from '../../floor-sync/kinds'
import { summaryOf } from '../../floor-sync/rules'
import {
  compareRecutRows,
  nextRecutScan,
  recutFinishRefusal,
  recutLines,
  recutMakeRefusal,
  recutStartRefusal,
  recutWarnings,
  recutZpl,
  sameShade,
  sourceWords,
  type RecutLot,
  type RecutMakeFacts,
} from '../rework/recut'
import { PRODUCTION_RECUTS, PRODUCTION_SECONDARY, PRODUCTION_TROLLEYS } from './permissions'
import { addRefusal, kindWords, moveRefusal, nextProcessOf, pendingWords, type AddFacts, type BundleProcess, type MoveFacts } from './secondary'
import {
  bundleLoadRefusal,
  differencesText,
  lineOfLoad,
  lineRefusal,
  lineWarnings,
  nextTrolleyStep,
  receiveRefusal,
  sendRefusal,
  sendWords,
  trolleyCodeOf,
  trolleyCodeProblem,
  trolleyLoadRefusal,
  unloadRefusal,
} from './trolley'

const released = { number: 'WO-0007', status: 'RELEASED', holdReason: null }
const lot = (id: string, extra: Partial<RecutLot> = {}): RecutLot => ({ id, code: `L-${id}`, itemId: 'lining', itemColourId: 'grey', dyeBatch: null, shade: null, ...extra })
const make = (extra: Partial<RecutMakeFacts> = {}): RecutMakeFacts => ({
  workOrder: released,
  bundle: { code: 'BN-1', status: 'ACTIVE', workOrderSizeId: 'cell-52', live: 6 },
  cell: { id: 'cell-52', label: 'BLK 52', parts: ['Body', 'Sleeve'] },
  part: 'Sleeve',
  quantity: 2,
  lot: lot('a', { dyeBatch: 'D7' }),
  endBits: false,
  materials: [{ itemId: 'lining', itemColourId: 'grey' }],
  shadeLots: [lot('a', { dyeBatch: 'D7' })],
  replacement: null,
  ...extra,
})

describe('recut tickets (MES-044): replacement panels that join the original bundle', () => {
  it('makes one for a live bundle of the cell, a part of the pattern, from the same shade lot or end bits', () => {
    expect(recutMakeRefusal(make())).toBeNull()
    expect(recutMakeRefusal(make({ part: null }))).toBeNull()
    expect(recutMakeRefusal(make({ lot: null, endBits: true }))).toBeNull()
    // Another lot of the same dye batch is the same shade; another batch is not.
    expect(recutMakeRefusal(make({ lot: lot('b', { dyeBatch: 'D7' }) }))).toBeNull()
    expect(recutMakeRefusal(make({ lot: lot('c', { dyeBatch: 'D8' }) }))?.code).toBe('LOT_NOT_SAME_SHADE')
    expect(recutMakeRefusal(make({ lot: lot('d', { itemId: 'leather' }) }))?.code).toBe('LOT_OTHER_MATERIAL')
    expect(recutMakeRefusal(make({ lot: null, endBits: false }))).toEqual({ code: 'NO_SOURCE', message: 'Say where the panels are cut from: the same shade lot, or end bits.' })
    expect(recutMakeRefusal(make({ part: 'Collar' }))).toEqual({ code: 'NOT_A_PART', message: 'Collar is not a part of BLK 52 (Body, Sleeve).' })
    // A cell whose parts are not known takes the part in words.
    expect(recutMakeRefusal(make({ part: 'Collar', cell: { id: 'cell-52', label: 'BLK 52', parts: [] } }))).toBeNull()
    expect(recutMakeRefusal(make({ quantity: 7 }))).toEqual({ code: 'MORE_THAN_BUNDLE', message: 'Bundle BN-1 carries 6 garments: recut 1 to 6 sets; 7 asked.' })
    expect(recutMakeRefusal(make({ bundle: { code: 'BN-1', status: 'VOID', workOrderSizeId: 'cell-52', live: 6 } }))?.code).toBe('BUNDLE_NOT_ACTIVE')
    expect(recutMakeRefusal(make({ bundle: { code: 'BN-1', status: 'ACTIVE', workOrderSizeId: 'cell-50', live: 6 } }))?.code).toBe('NOT_OF_CELL')
    expect(recutMakeRefusal(make({ bundle: null }))?.code).toBe('BUNDLE_NEEDED')
    expect(recutMakeRefusal(make({ workOrder: { number: 'WO-0007', status: 'ON_HOLD', holdReason: 'Shade claim' } }))).toEqual({
      code: 'WORK_ORDER_ON_HOLD',
      message: 'Work order WO-0007 is on hold (Shade claim): no panel is recut for it until the hold is lifted.',
    })
    expect(recutMakeRefusal(make({ workOrder: { number: 'WO-0007', status: 'COMPLETED', holdReason: null } }))?.code).toBe('WORK_ORDER_NOT_OPEN')
  })

  it('takes a replacement request of the office: an open RECUT of the cell and part, once, never more than it asks', () => {
    const replacement = { kind: 'RECUT' as const, status: 'OPEN', quantity: 2, part: 'Sleeve', workOrderSizeId: 'cell-52', recutTicketId: null }
    expect(recutMakeRefusal(make({ replacement }))).toBeNull()
    // A replacement of whole garments may name no bundle (its scrap named none).
    expect(recutMakeRefusal(make({ replacement: { ...replacement, part: null }, part: null, bundle: null }))).toBeNull()
    expect(recutMakeRefusal(make({ replacement: { ...replacement, kind: 'REDUCE' } }))?.code).toBe('REPLACEMENT_NOT_RECUT')
    expect(recutMakeRefusal(make({ replacement: { ...replacement, status: 'DONE' } }))?.code).toBe('REPLACEMENT_NOT_OPEN')
    expect(recutMakeRefusal(make({ replacement: { ...replacement, recutTicketId: 't1' } }))?.code).toBe('REPLACEMENT_HAS_TICKET')
    expect(recutMakeRefusal(make({ replacement: { ...replacement, workOrderSizeId: 'cell-50' } }))?.code).toBe('REPLACEMENT_OTHER_CELL')
    expect(recutMakeRefusal(make({ replacement: { ...replacement, part: 'Body' } }))?.message).toBe('That replacement recuts Body, not Sleeve.')
    expect(recutMakeRefusal(make({ replacement, quantity: 3 }))?.code).toBe('MORE_THAN_REPLACEMENT')
  })

  it('warns when the bundle’s shade lot is not known (a lot of the material is then taken, to check by eye)', () => {
    expect(sameShade(lot('z'), [])).toBe(true)
    expect(recutWarnings({ lot: lot('z'), shadeLots: [] })).toEqual([{ code: 'SHADE_UNKNOWN', message: "The bundle's shade lot is not known: check by eye that lot L-z matches its shade." }])
    expect(recutWarnings({ lot: lot('a'), shadeLots: [lot('a')] })).toEqual([])
    expect(recutWarnings({ lot: null, shadeLots: [] })).toEqual([])
  })

  it('is scanned at the start and at the end of cutting; a cut ticket, a voided one or a voided bundle stops it', () => {
    const ticket = { number: 'CT-9', kind: 'RECUT' as const, status: 'OPEN' as const, voidReason: null }
    expect(nextRecutScan(ticket, released, { code: 'BN-1', status: 'ACTIVE' })).toEqual({ next: 'START', refusal: null })
    expect(nextRecutScan({ ...ticket, status: 'STARTED' }, released, null)).toEqual({ next: 'FINISH', refusal: null })
    expect(nextRecutScan({ ...ticket, status: 'DONE' }, released, null).next).toBe('NONE')
    expect(recutStartRefusal({ ...ticket, kind: 'CUT' }, released, null)?.code).toBe('TICKET_IS_CUT')
    expect(recutStartRefusal({ ...ticket, status: 'VOID', voidReason: 'Lost' }, released, null)?.message).toBe('Recut ticket CT-9 was voided (Lost): nothing is cut for it.')
    expect(recutStartRefusal({ ...ticket, status: 'STARTED' }, released, null)?.code).toBe('TICKET_STARTED')
    expect(recutStartRefusal(ticket, { number: 'WO-0007', status: 'ON_HOLD', holdReason: null }, null)?.code).toBe('WORK_ORDER_ON_HOLD')
    expect(recutStartRefusal(ticket, released, { code: 'BN-1', status: 'VOID' })?.code).toBe('BUNDLE_VOID')
    expect(recutFinishRefusal(ticket)?.code).toBe('TICKET_NOT_STARTED')
    expect(recutFinishRefusal({ ...ticket, status: 'STARTED' })).toBeNull()
  })

  it('lists started first, then by due day, then the oldest', () => {
    const row = (number: string, status: string, dueDate: string | null, createdAt: string) => ({ number, status, dueDate, createdAt })
    const rows = [row('A', 'OPEN', null, '1'), row('B', 'OPEN', '2026-12-01', '2'), row('C', 'STARTED', null, '3'), row('D', 'OPEN', '2026-11-20', '4'), row('E', 'OPEN', '2026-11-20', '1')]
    expect(rows.sort(compareRecutRows).map((r) => r.number)).toEqual(['C', 'E', 'D', 'B', 'A'])
  })

  it('prints a label with the bundle it joins and where it is cut from, in Italian or English', () => {
    const label = { code: 'CTA-2026-00007', language: 'it' as const, maker: 'Seed A', workOrderNumber: 'WO-0007', style: 'JKT-02', cell: 'BLK 52', part: 'Manica', quantity: 2, bundleCode: 'BN-1', lotCode: 'L-1', endBits: true, due: '2026-12-01' }
    expect(recutLines(label)).toEqual({
      heading: 'Seed A · Buono di ritaglio',
      title: 'Manica × 2 serie · JKT-02 BLK 52',
      fields: [
        { label: 'Ordine di lavoro', value: 'WO-0007' },
        { label: 'Unire al fascio', value: 'BN-1' },
        { label: 'Tagliare da', value: 'Lotto L-1 + Ritagli' },
        { label: 'Consegna', value: '2026-12-01' },
      ],
    })
    expect(recutLines({ ...label, language: 'en', part: null, maker: null, due: null }).title).toBe('Whole garments × 2 sets · JKT-02 BLK 52')
    expect(sourceWords({ lotCode: null, endBits: true }, 'en')).toBe('End bits')
    const zpl = recutZpl(label, { widthMm: 100, heightMm: 60, dpi: 203 })
    expect(zpl).toContain('^FDCTA-2026-00007^FS')
    expect(zpl).toContain('^PQ1')
    expect(() => recutZpl(label, { widthMm: 40, heightMm: 30, dpi: 203 })).toThrow(RangeError)
  })
})

describe('secondary processes after cutting (MES-047): a route step before sewing', () => {
  const add = (extra: Partial<AddFacts> = {}): AddFacts => ({
    workOrder: released,
    bundle: { code: 'BN-1', status: 'ACTIVE', live: 6 },
    kind: 'FUSING',
    place: 'IN_HOUSE',
    quantity: 6,
    workCentre: { code: 'FUS', ok: true },
    processes: [],
    onTrolley: null,
    ...extra,
  })
  it('gives a live bundle one open process of a kind, in house at an active work centre or outside', () => {
    expect(addRefusal(add())).toBeNull()
    expect(addRefusal(add({ place: 'OUTSIDE', workCentre: null }))).toBeNull()
    expect(addRefusal(add({ workCentre: null }))).toBeNull()
    expect(addRefusal(add({ processes: [{ kind: 'FUSING', place: 'IN_HOUSE', status: 'WAITING' }] }))?.code).toBe('KIND_OPEN_ALREADY')
    expect(addRefusal(add({ processes: [{ kind: 'FUSING', place: 'IN_HOUSE', status: 'DONE' }] }))).toBeNull()
    expect(addRefusal(add({ quantity: 7 }))?.code).toBe('MORE_THAN_BUNDLE')
    expect(addRefusal(add({ onTrolley: 'T-3' }))?.message).toBe('Bundle BN-1 is on trolley T-3 to sewing: it takes no process after cutting now.')
    expect(addRefusal(add({ place: 'OUTSIDE' }))?.code).toBe('WORK_CENTRE_OUTSIDE')
    expect(addRefusal(add({ workCentre: { code: 'OLD', ok: false } }))?.code).toBe('NOT_A_WORK_CENTRE')
    expect(addRefusal(add({ bundle: { code: 'BN-1', status: 'VOID', live: 6 } }))?.code).toBe('BUNDLE_NOT_ACTIVE')
    expect(addRefusal(add({ workOrder: { number: 'WO-0007', status: 'ON_HOLD', holdReason: null } }))).toEqual({ code: 'WORK_ORDER_ON_HOLD', message: 'Work order WO-0007 is on hold: its bundles take no process until the hold is lifted.' })
  })

  it('moves WAITING → IN_PROGRESS → DONE; an outside process is sent from the office under an issued order of its work order', () => {
    const move = (extra: Partial<MoveFacts> = {}): MoveFacts => ({ workOrder: released, process: { kind: 'FUSING', place: 'IN_HOUSE', status: 'WAITING', bundleCode: 'BN-1' }, floor: true, workCentre: null, subcontract: null, ...extra })
    expect(moveRefusal('start', move())).toBeNull()
    expect(moveRefusal('done', move())).toEqual({ code: 'WRONG_STATE', message: 'The fusing of bundle BN-1 waits: start it first.' })
    expect(moveRefusal('done', move({ process: { kind: 'FUSING', place: 'IN_HOUSE', status: 'IN_PROGRESS', bundleCode: 'BN-1' } }))).toBeNull()
    expect(moveRefusal('cancel', move({ process: { kind: 'FUSING', place: 'IN_HOUSE', status: 'DONE', bundleCode: 'BN-1' } }))?.code).toBe('WRONG_STATE')
    expect(moveRefusal('cancel', move({ workOrder: { number: 'WO-0007', status: 'ON_HOLD', holdReason: null } }))).toBeNull()
    expect(moveRefusal('start', move({ workOrder: { number: 'WO-0007', status: 'ON_HOLD', holdReason: null } }))?.code).toBe('WORK_ORDER_ON_HOLD')
    expect(moveRefusal('start', move({ workCentre: { code: 'OLD', ok: false } }))?.code).toBe('NOT_A_WORK_CENTRE')
    const outside = { kind: 'EMBROIDERY' as const, place: 'OUTSIDE' as const, status: 'WAITING' as const, bundleCode: 'BN-1' }
    expect(moveRefusal('start', move({ process: outside }))?.code).toBe('OUTSIDE_FROM_OFFICE')
    expect(moveRefusal('start', move({ process: outside, floor: false }))?.code).toBe('SUBCONTRACT_NEEDED')
    expect(moveRefusal('start', move({ process: outside, floor: false, subcontract: { number: 'SC-1', sameWorkOrder: true, status: 'DRAFT' } }))?.message).toBe('Subcontract order SC-1 is draft: send it under an issued order of its work order.')
    expect(moveRefusal('start', move({ process: outside, floor: false, subcontract: { number: 'SC-1', sameWorkOrder: false, status: 'ISSUED' } }))?.code).toBe('SUBCONTRACT_NOT_SENDABLE')
    expect(moveRefusal('start', move({ process: outside, floor: false, subcontract: { number: 'SC-1', sameWorkOrder: true, status: 'AT_WORKSHOP' } }))).toBeNull()
  })

  it('answers what a scan of the bundle does next at this work centre', () => {
    const process = (id: string, seq: number, status: BundleProcess['status'], workCentreId: string | null): BundleProcess => ({ id, seq, kind: 'FUSING', place: 'IN_HOUSE', status, workCentreId })
    const rows = [process('p1', 20, 'WAITING', 'wc-emb'), process('p2', 10, 'WAITING', 'wc-fus'), process('p0', 5, 'DONE', 'wc-per')]
    expect(nextProcessOf(rows, 'wc-emb')).toMatchObject({ process: { id: 'p1' }, move: 'start' })
    expect(nextProcessOf(rows, null)).toMatchObject({ process: { id: 'p2' }, move: 'start' })
    expect(nextProcessOf([...rows, process('p3', 30, 'IN_PROGRESS', 'wc-x')], null)).toMatchObject({ process: { id: 'p3' }, move: 'done' })
    expect(nextProcessOf([process('p0', 5, 'DONE', null)], null)).toBeNull()
    expect(pendingWords('BN-1', [{ kind: 'FUSING' }, { kind: 'EMBROIDERY' }], 'en')).toBe('Bundle BN-1 waits for fusing, embroidery: it goes to sewing after them.')
    expect(pendingWords('BN-1', [], 'it')).toBeNull()
    expect(kindWords('PERFORATION', 'it')).toBe('foratura')
  })
})

describe('cut issue to sewing (MES-048): bundles onto a trolley, to a line, confirmed by its scan', () => {
  it('reads a trolley label as typed, upper case, without spaces', () => {
    expect(trolleyCodeOf(' t-3 ')).toBe('T-3')
    expect(trolleyCodeProblem('T-3')).toBeNull()
    expect(trolleyCodeProblem('T 3')).toBe('T 3 is not a trolley label: letters and digits, no spaces, at most 20.')
    expect(trolleyCodeProblem('')).toBe('Scan the trolley’s label.')
  })

  it('loads a live bundle past its processes onto one open trolley; the line is the one named or the planned one', () => {
    const facts = { trolleyCode: 'T-3', workOrder: released, bundle: { code: 'BN-1', status: 'ACTIVE' }, pending: [], onTrolley: null }
    expect(bundleLoadRefusal(facts)).toBeNull()
    expect(bundleLoadRefusal({ ...facts, pending: [{ kind: 'FUSING' as const }] })).toEqual({ code: 'PROCESS_PENDING', message: 'Bundle BN-1 waits for fusing: it goes to sewing after it.' })
    expect(bundleLoadRefusal({ ...facts, onTrolley: 'T-3' })?.code).toBe('ON_THIS_TROLLEY')
    expect(bundleLoadRefusal({ ...facts, onTrolley: 'T-9' })?.message).toBe('Bundle BN-1 is on trolley T-9: take it off there first.')
    expect(bundleLoadRefusal({ ...facts, bundle: { code: 'BN-1', status: 'VOID' } })?.code).toBe('BUNDLE_NOT_ACTIVE')
    expect(bundleLoadRefusal({ ...facts, workOrder: { number: 'WO-0007', status: 'ON_HOLD', holdReason: 'Stain' } })?.code).toBe('WORK_ORDER_ON_HOLD')
    expect(trolleyLoadRefusal({ trolleyCode: 'T-3', status: 'SENT', bundles: 4 }, 'T-3')?.code).toBe('TROLLEY_SENT')
    expect(trolleyLoadRefusal({ trolleyCode: 'T-3', status: 'LOADING', bundles: 200 }, 'T-3')?.code).toBe('TROLLEY_FULL')
    expect(trolleyLoadRefusal(null, 'T-3')).toBeNull()
    expect(lineOfLoad(undefined, 'L1')).toBe('L1')
    expect(lineOfLoad('L2', 'L1')).toBe('L2')
    expect(lineOfLoad(null, null)).toBeNull()
    expect(lineRefusal(null)?.code).toBe('LINE_NEEDED')
    expect(lineRefusal({ code: 'L9', status: 'INACTIVE', sameSite: true })?.code).toBe('LINE_NOT_ACTIVE')
    expect(lineRefusal({ code: 'L1', status: 'ACTIVE', sameSite: true })).toBeNull()
    expect(lineWarnings({ id: 'l2', code: 'L2' }, { code: 'BN-1' }, { id: 'l1', code: 'L1' })).toEqual([{ code: 'PLANNED_ON_OTHER_LINE', message: "Bundle BN-1's work order is planned on line L1, not L2." }])
    expect(lineWarnings({ id: 'l1', code: 'L1' }, { code: 'BN-1' }, null)).toEqual([])
  })

  it('sends a loaded trolley, receives a sent one at its own line, with the differences in words', () => {
    const loading = { trolleyCode: 'T-3', status: 'LOADING' as const, bundles: 12 }
    expect(sendRefusal(loading, 'T-3')).toBeNull()
    expect(sendRefusal({ ...loading, bundles: 0 }, 'T-3')?.code).toBe('TROLLEY_EMPTY')
    expect(sendRefusal(null, 'T-3')?.code).toBe('NO_OPEN_TROLLEY')
    expect(sendRefusal({ ...loading, status: 'SENT' }, 'T-3')?.code).toBe('TROLLEY_NOT_LOADING')
    const line2 = { id: 'l2', code: 'L2' }
    expect(receiveRefusal({ ...loading, status: 'SENT' }, 'T-3', line2, line2)).toBeNull()
    expect(receiveRefusal({ ...loading, status: 'SENT' }, 'T-3', line2, null)).toBeNull()
    expect(receiveRefusal({ ...loading, status: 'SENT' }, 'T-3', line2, { id: 'l1', code: 'L1' })).toEqual({ code: 'OTHER_LINE', message: 'Trolley T-3 goes to line L2; this tablet is at line L1.' })
    expect(receiveRefusal(loading, 'T-3', line2, null)?.code).toBe('TROLLEY_NOT_SENT')
    expect(unloadRefusal(loading, 'T-3', 'BN-1', false)?.code).toBe('NOT_ON_TROLLEY')
    expect(unloadRefusal({ ...loading, status: 'SENT' }, 'T-3', 'BN-1', true)?.code).toBe('TROLLEY_NOT_LOADING')
    expect(unloadRefusal(loading, 'T-3', 'BN-1', true)).toBeNull()
    expect(differencesText(['BN-4'], ['BN-9'])).toBe('Not found on the trolley: BN-4. Named missing but not on it: BN-9.')
    expect(differencesText([], [])).toBeNull()
    expect(nextTrolleyStep(null)).toBe('LOAD')
    expect(nextTrolleyStep({ status: 'SENT' })).toBe('RECEIVE')
    expect(nextTrolleyStep({ status: 'RECEIVED' })).toBe('NONE')
    expect(sendWords(12, 'L2', 'en')).toBe('Send 12 bundles to line L2')
    expect(sendWords(1, 'L2', 'it')).toBe('Invia 1 fascio alla linea L2')
  })
})

describe('permissions, events and the floor queue', () => {
  it('declares three write permissions the floor shares, given to the office and floor templates', () => {
    for (const name of [PRODUCTION_RECUTS, PRODUCTION_SECONDARY, PRODUCTION_TROLLEYS]) {
      expect(FACTORY_PERMISSIONS.get(name)).toMatchObject({ area: 'production', risk: 'write' })
      expect(FLOOR_SHARED_PERMISSIONS).toContain(name)
    }
    expect(templateOf('production_manager')?.permissions).toEqual(expect.arrayContaining([PRODUCTION_RECUTS, PRODUCTION_SECONDARY, PRODUCTION_TROLLEYS]))
    expect(templateOf('quality_inspector')?.permissions).toContain(PRODUCTION_RECUTS)
    expect(templateOf('quality_inspector')?.permissions).not.toContain(PRODUCTION_TROLLEYS)
    expect(templateOf('team_leader')?.permissions).toEqual(expect.arrayContaining([PRODUCTION_RECUTS, PRODUCTION_SECONDARY, PRODUCTION_TROLLEYS]))
    expect(templateOf('floor_inspector')?.permissions).toContain(PRODUCTION_RECUTS)
    expect(templateOf('cutting_operator')?.permissions).toEqual(expect.arrayContaining([PRODUCTION_SECONDARY, PRODUCTION_TROLLEYS]))
    expect(templateOf('cutting_operator')?.permissions).not.toContain(PRODUCTION_RECUTS)
    expect(templateOf('buyer')?.permissions ?? []).not.toContain(PRODUCTION_TROLLEYS)
  })

  it('declares the three events with their live rules (office: the Cutting page; floor: the tablets that act on them)', () => {
    expect(EVENT_CATALOGUE.find('recut_ticket.changed', 1)?.live).toMatchObject({ permission: 'production.cutting.view', floor: 'production.cut' })
    expect(EVENT_CATALOGUE.find('secondary_process.changed', 1)?.live).toMatchObject({ permission: 'production.cutting.view', floor: 'production.secondary' })
    expect(EVENT_CATALOGUE.find('cut_issue.changed', 1)?.live).toMatchObject({ permission: 'production.cutting.view', floor: 'production.trolleys' })
  })

  it('queues the trolley steps offline under production.trolleys, summarised by the trolley and the bundle', () => {
    for (const kind of ['production.trolley.load', 'production.trolley.unload', 'production.trolley.send', 'production.trolley.receive'] as const) {
      expect(QUEUED_ACTIONS[kind]).toMatchObject({ permission: 'production.trolleys', numbers: null })
    }
    expect(summaryOf('production.trolley.load', { trolley: 'T-3', bundle: 'BN-1' })).toEqual({ code: 'BN-1', target: 'T-3' })
    expect(summaryOf('production.trolley.receive', { trolley: 'T-3', missing: ['BN-4'] })).toEqual({ target: 'T-3', quantity: 1 })
    expect(summaryOf('production.trolley.send', { trolley: 'T-3' })).toEqual({ target: 'T-3' })
  })
})
