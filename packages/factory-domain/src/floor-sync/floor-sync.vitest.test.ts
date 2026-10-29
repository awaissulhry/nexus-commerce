import { describe, expect, it } from 'vitest'
import { FACTORY_PERMISSIONS, FLOOR_SHARED_PERMISSIONS } from '../auth/permissions/catalogue'
import { ROLE_TEMPLATES } from '../auth/roles/templates'
import { EVENT_CATALOGUE } from '../events/catalogue'
import { FLOOR_DOCUMENT_KINDS } from '../numbering/kinds'
import { FLOOR_SYNC_KINDS, ONLINE_ONLY_ACTIONS, QUEUED_ACTIONS, offlineBehaviourOf } from './kinds'
import { FLOOR_SYNC_DISCARD, FLOOR_SYNC_VIEW } from './permissions'
import { CLIENT_EVENT_ID, errorRefusal, inDeviceOrder, isOwnRefusal, moduleRefusal, otherWorkerRefusal, summaryOf } from './rules'

describe('what queues offline and what waits for the network', () => {
  it('queues the scan, cut and bundle actions, each under a floor permission the floor roles may hold', () => {
    for (const kind of FLOOR_SYNC_KINDS) {
      const behaviour = offlineBehaviourOf(kind)
      expect(behaviour?.queues).toBe(true)
      expect(FLOOR_SHARED_PERMISSIONS).toContain(QUEUED_ACTIONS[kind].permission)
    }
    // Only the bundle ticket prints offline from the tablet's own block today.
    expect(FLOOR_SYNC_KINDS.filter((kind) => QUEUED_ACTIONS[kind].numbers !== null)).toEqual(['production.bundles.make'])
    expect(QUEUED_ACTIONS['production.bundles.make'].numbers).toBe('BUNDLE')
  })

  it('holds receipts, inspections, releases and garment serials: their numbers are given online (floor-doc-numbers)', () => {
    for (const action of ONLINE_ONLY_ACTIONS) {
      const behaviour = offlineBehaviourOf(action)
      expect(behaviour?.queues).toBe(false)
      if (behaviour && !behaviour.queues) expect(behaviour.held.message).toMatch(/network/)
    }
    // Every floor document kind (gapless series) belongs to an action that waits for the network.
    expect([...FLOOR_DOCUMENT_KINDS].sort()).toEqual(['GOODS_RECEIPT', 'INSPECTION', 'LOT', 'RELEASE'])
    expect(offlineBehaviourOf('sales.quote')).toBeNull()
  })
})

describe('one send in the tablet order', () => {
  it('orders the events by seq, whatever order they came in', () => {
    const sent = [
      { clientEventId: 'evt-00000003', seq: 7 },
      { clientEventId: 'evt-00000001', seq: 3 },
      { clientEventId: 'evt-00000002', seq: 5 },
    ]
    const ordered = inDeviceOrder(sent)
    expect(ordered.ok && ordered.events.map((event) => event.seq)).toEqual([3, 5, 7])
  })

  it('refuses a seq or an id named twice', () => {
    expect(inDeviceOrder([{ clientEventId: 'evt-00000001', seq: 1 }, { clientEventId: 'evt-00000002', seq: 1 }])).toEqual({ ok: false, problem: 'seq 1 is sent twice.' })
    expect(inDeviceOrder([{ clientEventId: 'evt-00000001', seq: 1 }, { clientEventId: 'evt-00000001', seq: 2 }])).toEqual({ ok: false, problem: 'client event evt-00000001 is sent twice.' })
  })

  it("takes a UUID as the tablet's id for an event", () => {
    expect(CLIENT_EVENT_ID.test('0192f1a2-7b3c-7d4e-8f50-123456789abc')).toBe(true)
    expect(CLIENT_EVENT_ID.test('short')).toBe(false)
  })
})

describe('refusals in words, one fix, final or not', () => {
  it("keeps a scan refusal's own fix and final", () => {
    expect(moduleRefusal({ code: 'PREVIOUS_NOT_REPORTED', message: 'Op 20 is not reported yet.', fix: 'Report Op 20 first.', final: false })).toEqual({ code: 'PREVIOUS_NOT_REPORTED', message: 'Op 20 is not reported yet.', fix: 'Report Op 20 first.', final: false })
  })

  it('gives a bundle or cut refusal its fix and decides whether it passes later', () => {
    expect(moduleRefusal({ code: 'FLOOR_NOT_READY', message: 'Bundles are held at this site until its floor is ready.' })).toMatchObject({ final: false, fix: expect.stringMatching(/again by itself/) })
    expect(moduleRefusal({ code: 'HIDE_USED_UP', message: 'Hide HD-1 is used up.' })).toMatchObject({ final: true, fix: 'Discard it: the hide is used up.' })
    expect(moduleRefusal({ code: 'NOT_RESERVED', message: 'BN-… is not in this tablet’s block.' })).toMatchObject({ final: true, fix: expect.stringMatching(/new label/) })
    expect(moduleRefusal({ code: 'SOMETHING_NEW', message: 'x' })).toMatchObject({ final: true, fix: 'Discard it, or ask your team leader.' })
  })

  it('turns a module error without a refusal into one', () => {
    expect(errorRefusal({ code: 'not_found', message: 'Work order not found.' })).toMatchObject({ code: 'NOT_FOUND', final: true })
    expect(errorRefusal({ code: 'validation_failed', message: 'Bad.', issues: [{ path: 'body/cells', message: 'Send one event per bundle.' }] })).toMatchObject({ code: 'BAD_EVENT', message: expect.stringContaining('Send one event per bundle. (body/cells)'), final: true })
    expect(errorRefusal({ code: 'forbidden', message: 'You may not do this.' })).toMatchObject({ code: 'NOT_ALLOWED', final: true })
    expect(errorRefusal({ code: 'conflict', message: 'The worker has not acknowledged the notice.' })).toMatchObject({ code: 'CONFLICT', final: false })
    expect(otherWorkerRefusal()).toMatchObject({ code: 'OTHER_WORKER', final: false })
  })
})

describe('what an event was, for the lists', () => {
  it('keeps known facts only: no money, no person', () => {
    expect(summaryOf('production.scan.report', { code: 'BN-AB-000123-7', good: 18, scrap: [{ reason: 'STAIN', quantity: 2 }], rework: [], workerId: 'x', price: 9 })).toEqual({ code: 'BN-AB-000123-7', good: 18, scrap: 2, rework: 0 })
    expect(summaryOf('production.bundles.make', { workOrderId: 'w', cells: [{ workOrderSizeId: 'c', quantities: [12] }], ticketCode: 'BN-AB-000201-3' })).toEqual({ code: 'BN-AB-000201-3', quantity: 12, workOrderId: 'w' })
    expect(summaryOf('production.cut.log', { code: 'HD-AB-000011-2', lines: [{ workOrderSizeId: 'c', sets: 3 }, { workOrderSizeId: 'd', sets: 2 }] })).toEqual({ code: 'HD-AB-000011-2', sets: 5 })
    expect(summaryOf('production.scan.undo', { undoesClientScanId: 'evt-00000001' })).toEqual({ target: 'evt-00000001' })
    expect(summaryOf('production.scan.report', null)).toEqual({ code: null, good: 0, scrap: 0, rework: 0 })
  })
})

describe("whose refused action it is (Statuto dei Lavoratori art. 4: others' are counted, never shown)", () => {
  it('at a site that names workers: only the ones that name the viewer', () => {
    const viewer = { workerId: 'w1', subject: 'WORKER' as const }
    expect(isOwnRefusal({ workerId: 'w1' }, viewer)).toBe(true)
    expect(isOwnRefusal({ workerId: 'w2' }, viewer)).toBe(false)
    expect(isOwnRefusal({ workerId: null }, viewer)).toBe(false)
  })

  it("at a station site: every refused action of the tablet", () => {
    expect(isOwnRefusal({ workerId: null }, { workerId: 'w1', subject: 'STATION' })).toBe(true)
  })
})

describe('declared', () => {
  it('declares the two office permissions and gives them to the people who must act', () => {
    expect(FACTORY_PERMISSIONS.isDeclared(FLOOR_SYNC_VIEW)).toBe(true)
    expect(FACTORY_PERMISSIONS.isDeclared(FLOOR_SYNC_DISCARD)).toBe(true)
    const holders = ROLE_TEMPLATES.filter((role) => role.permissions.includes(FLOOR_SYNC_DISCARD)).map((role) => role.key)
    expect(holders.sort()).toEqual(['admin', 'floor_supervisor', 'owner', 'production_manager', 'warehouse'])
    expect(ROLE_TEMPLATES.find((role) => role.key === 'read_only')?.permissions).toContain(FLOOR_SYNC_VIEW)
    // Never a floor role's: a tablet sees its own refused actions with floor.work.
    expect(ROLE_TEMPLATES.filter((role) => role.audience === 'floor').some((role) => role.permissions.some((name) => name.startsWith('floorsync.')))).toBe(false)
  })

  it('declares the two events', () => {
    expect(EVENT_CATALOGUE.find('floor.action_refused', 1)).toBeDefined()
    expect(EVENT_CATALOGUE.find('floor.refused_action_closed', 1)).toBeDefined()
  })
})
