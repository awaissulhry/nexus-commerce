import { describe, expect, it } from 'vitest'
import { grainPermission } from '../auth/grains/grains'
import { templateOf } from '../auth/roles/templates'
import type { Actor, Grant, Permission } from '../core/permissions'
import { EVENT_CATALOGUE } from '../events/catalogue'
import {
  ACTION_REFUSALS,
  actionRefusal,
  DEFAULT_LAYOUT,
  layoutOf,
  layoutProblems,
  layoutToStore,
  NOTE_MAX,
  parseRowKey,
  resolveNoteProblem,
  responsibleFor,
  rowActionsOf,
  TODAY_SECTIONS,
  withActions,
  type StoredAction,
} from './actions'
import { ACTION_EVENTS, attentionFor, conditionOf, liveEventsOf, rowKeyOf, type AttentionCandidate, type AttentionKind, type Viewer } from './attention'
import type { Phrase } from './words'

/**
 * Today's actions (B-W1-52 actions; design home.today "alert → Acknowledge · Assign · Resolve", popups assign,
 * resolve-note, arrange): the row's condition, what an action holds for, who may do what, and "Arrange Today".
 */

const TENANT = '01900000-0000-7000-8000-000000000001'
const A = '01900000-0000-7000-8000-00000000000a'
const B = '01900000-0000-7000-8000-00000000000b'
const SITE_A = '01900000-0000-7000-8000-0000000000a1'
const P1 = '01900000-0000-7000-8000-0000000000f1'
const ME = '01900000-0000-7000-8000-0000000000e1'
const OTHER = '01900000-0000-7000-8000-0000000000e2'
const NOW = new Date('2026-10-29T09:00:00.000Z')

function roleActor(key: string, companies: Grant['companies'] = 'all', sites: Grant['sites'] = 'all'): Actor {
  const template = templateOf(key)!
  return { audience: 'office', tenantId: TENANT, grants: [{ permissions: [...template.permissions, ...template.grains.map((grain) => grainPermission(grain) as Permission)], companies, sites, parties: 'all' }] }
}
const viewerOf = (actor: Actor, personId = ME): Viewer => ({ actor, personId, today: '2026-10-29', now: NOW })
const says = (text: string): Phrase => ({ key: 'test', params: {}, text })

let serial = 0
function candidate(kind: AttentionKind, extra: Partial<AttentionCandidate> = {}): AttentionCandidate {
  serial += 1
  return {
    kind,
    state: 'LATE',
    severity: 'HIGH',
    record: { type: 'Thing', id: `01900000-0000-7000-8000-${String(serial).padStart(12, '0')}`, label: `T-${serial}` },
    scope: { companyId: A, siteId: null, partyId: P1 },
    sentence: says(`Row ${serial}.`),
    blocks: null,
    due: '2026-10-27',
    since: new Date('2026-10-20T09:00:00.000Z'),
    ...extra,
  }
}
const itemOf = (row: AttentionCandidate, viewer = viewerOf(roleActor('owner'))) => attentionFor(viewer, [row])[0]!

function stored(item: { readonly key: string }, extra: Partial<StoredAction> = {}): StoredAction {
  return {
    id: '01900000-0000-7000-8000-0000000000aa',
    rowKey: item.key,
    version: 3,
    assignedToId: null,
    assignedById: null,
    assignedAt: null,
    resolvedCondition: null,
    resolvedById: null,
    resolvedAt: null,
    acknowledgedCondition: null,
    acknowledgedById: null,
    acknowledgedAt: null,
    ...extra,
  }
}

describe('a row’s condition: what an action holds for', () => {
  it('is the same while the row needs a person for the same reason, also as days pass', () => {
    const row = candidate('ORDER_PROMISE')
    expect(conditionOf(row)).toMatch(/^[0-9a-f]{32}$/)
    const later: AttentionCandidate = { ...row, sentence: says('Now 3 days late.'), severity: 'MEDIUM' }
    expect(conditionOf(later)).toBe(conditionOf(row))
    expect(itemOf(row).condition).toBe(conditionOf(row))
  })

  it('changes with the state, the due date, since when it waits and the codes that make it (in any order)', () => {
    const row = candidate('WORK_ORDER_HELD', { condition: ['BOM', 'CERTIFICATE'] })
    expect(conditionOf({ ...row, state: 'AT_RISK' })).not.toBe(conditionOf(row))
    expect(conditionOf({ ...row, due: '2026-11-03' })).not.toBe(conditionOf(row))
    expect(conditionOf({ ...row, since: new Date('2026-10-28T09:00:00.000Z') })).not.toBe(conditionOf(row))
    expect(conditionOf({ ...row, condition: ['BOM'] })).not.toBe(conditionOf(row))
    expect(conditionOf({ ...row, condition: ['CERTIFICATE', 'BOM'] })).toBe(conditionOf(row))
    expect(conditionOf({ ...row, kind: 'LOT_HOLD' })).not.toBe(conditionOf(row))
  })

  it('the row key names the kind, the record and the sub key; parseRowKey reads it back, and nothing else', () => {
    const row = candidate('INVOICE_TO_ISSUE', { subKey: `${A}:2026-10` })
    const key = rowKeyOf(row)
    expect(key).toBe(`INVOICE_TO_ISSUE:${row.record.id}:${A}:2026-10`)
    expect(parseRowKey(key)).toEqual({ kind: 'INVOICE_TO_ISSUE', recordId: row.record.id, subKey: `${A}:2026-10` })
    expect(parseRowKey(`LOT_HOLD:${row.record.id}`)).toEqual({ kind: 'LOT_HOLD', recordId: row.record.id, subKey: null })
    for (const bad of ['', 'LOT_HOLD', `NOT_A_KIND:${row.record.id}`, `LOT_HOLD:not-a-uuid`, `lot_hold:${row.record.id}`, `LOT_HOLD:${row.record.id}:${'x'.repeat(300)}`, `LOT_HOLD:${row.record.id}:a b`]) {
      expect(parseRowKey(bad)).toBeNull()
    }
  })
})

describe('what is stored, laid over the rows', () => {
  it('a row resolved in its present condition is off Today; it comes back when its condition changes', () => {
    const row = candidate('ORDER_PROMISE')
    const item = itemOf(row)
    const resolved = stored(item, { resolvedCondition: item.condition, resolveNote: 'Called the customer', resolvedById: OTHER, resolvedAt: NOW } as Partial<StoredAction>)
    expect(withActions([item], new Map([[item.key, resolved]]))).toEqual({ items: [], resolved: 1 })
    const moved = itemOf({ ...row, due: '2026-11-05' })
    expect(moved.key).toBe(item.key)
    const back = withActions([moved], new Map([[item.key, resolved]]))
    expect(back.resolved).toBe(0)
    expect(back.items[0]!.actions).toMatchObject({ version: 3, verbs: ['ASSIGN', 'RESOLVE', 'ACKNOWLEDGE'], assigned: null, acknowledged: null })
  })

  it('an acknowledgement marks the row while its condition holds; an assignment holds across conditions', () => {
    const row = candidate('LOT_HOLD', { state: 'QUARANTINE', due: null })
    const item = itemOf(row)
    const action = stored(item, { acknowledgedCondition: item.condition, acknowledgedById: OTHER, acknowledgedAt: NOW, assignedToId: ME, assignedById: OTHER, assignedAt: NOW })
    expect(rowActionsOf(item, action)).toEqual({ condition: item.condition, version: 3, verbs: ['ASSIGN', 'RESOLVE'], assigned: { toId: ME, byId: OTHER, at: NOW }, acknowledged: { byId: OTHER, at: NOW } })
    const blocked = itemOf({ ...row, state: 'BLOCKED' })
    expect(rowActionsOf(blocked, action)).toMatchObject({ verbs: ['ASSIGN', 'RESOLVE', 'ACKNOWLEDGE'], assigned: { toId: ME }, acknowledged: null })
  })

  it('nothing stored: version 0; an approval or a mail takes none of the verbs', () => {
    const alert = itemOf(candidate('ORDER_PROMISE'))
    expect(rowActionsOf(alert, undefined)).toEqual({ condition: alert.condition, version: 0, verbs: ['ASSIGN', 'RESOLVE', 'ACKNOWLEDGE'], assigned: null, acknowledged: null })
    for (const kind of ['QUOTE_APPROVAL', 'MAIL_TO_SORT', 'PO_PROPOSAL', 'SCAN_CORRECTION'] as const) {
      const approval = itemOf(candidate(kind, { scope: { companyId: A, siteId: SITE_A, partyId: P1 } }))
      expect(rowActionsOf(approval, undefined).verbs).toEqual([])
      expect(actionRefusal('RESOLVE', approval, undefined, { condition: approval.condition })).toBe('NOT_AN_ALERT')
    }
  })
})

describe('refusals, in words', () => {
  const item = itemOf(candidate('ORDER_PROMISE'))

  it('a changed condition, a row resolved meanwhile, a second acknowledgement, an assignment that changes nothing', () => {
    expect(actionRefusal('ACKNOWLEDGE', item, undefined, { condition: item.condition })).toBeNull()
    expect(actionRefusal('ACKNOWLEDGE', item, undefined, { condition: '0'.repeat(32) })).toBe('CHANGED')
    expect(actionRefusal('ASSIGN', item, stored(item, { resolvedCondition: item.condition }), { condition: item.condition, assigneeId: OTHER })).toBe('ALREADY_RESOLVED')
    expect(actionRefusal('ACKNOWLEDGE', item, stored(item, { acknowledgedCondition: item.condition }), { condition: item.condition })).toBe('ALREADY_ACKNOWLEDGED')
    expect(actionRefusal('ACKNOWLEDGE', item, stored(item, { acknowledgedCondition: 'f'.repeat(32) }), { condition: item.condition })).toBeNull()
    expect(actionRefusal('ASSIGN', item, stored(item, { assignedToId: OTHER }), { condition: item.condition, assigneeId: OTHER })).toBe('ALREADY_ASSIGNED')
    expect(actionRefusal('ASSIGN', item, undefined, { condition: item.condition, assigneeId: null })).toBe('NOT_ASSIGNED')
    expect(actionRefusal('ASSIGN', item, stored(item, { assignedToId: OTHER }), { condition: item.condition, assigneeId: null })).toBeNull()
    for (const words of Object.values(ACTION_REFUSALS)) expect(words).toMatch(/^[A-Z].+\.$/)
  })

  it('a resolve note says what was done: 3 to 1000 characters, spaces around it not counted', () => {
    expect(resolveNoteProblem('Called the customer, new date agreed')).toBeNull()
    expect(resolveNoteProblem('  ok  ')).toMatch(/at least 3/)
    expect(resolveNoteProblem('')).toMatch(/at least 3/)
    expect(resolveNoteProblem(`  ${'x'.repeat(NOTE_MAX)}  `)).toBeNull()
    expect(resolveNoteProblem('x'.repeat(NOTE_MAX + 1))).toMatch(/1000/)
  })
})

describe('who a row is assigned to', () => {
  it('a person whose grant that acts on the row names its site, or its company, is suggested first', () => {
    const lot = { companyId: A, siteId: SITE_A, partyId: null }
    expect(responsibleFor(roleActor('quality_inspector', [A], [SITE_A]), 'quality.lots.release', lot)).toBe(true)
    expect(responsibleFor(roleActor('quality_inspector'), 'quality.lots.release', lot)).toBe(false)
    expect(responsibleFor(roleActor('sales', [A]), 'orders.manage', { companyId: A, siteId: null, partyId: P1 })).toBe(true)
    expect(responsibleFor(roleActor('sales', [B]), 'orders.manage', { companyId: A, siteId: null, partyId: P1 })).toBe(false)
    expect(responsibleFor(roleActor('buyer', [A]), 'orders.manage', { companyId: A, siteId: null, partyId: P1 })).toBe(false)
  })
})

describe('the live list: action events with the alerts', () => {
  it('a person with an alert kind refreshes on the three action events, each declared with a live rule', () => {
    expect(liveEventsOf(['ORDER_PROMISE'])).toEqual(expect.arrayContaining([...ACTION_EVENTS]))
    expect(liveEventsOf(['QUOTE_APPROVAL', 'MAIL_TO_SORT'])).not.toEqual(expect.arrayContaining(['attention.resolved']))
    for (const type of ACTION_EVENTS) expect(EVENT_CATALOGUE.get(type, 1).live).toMatchObject({ permission: 'home.view' })
  })
})

describe('Arrange Today', () => {
  it('nothing saved: every section shown in the design’s order, no panels, no main lens', () => {
    expect(layoutOf(null)).toBe(DEFAULT_LAYOUT)
    expect(DEFAULT_LAYOUT.sections.map((section) => section.id)).toEqual([...TODAY_SECTIONS])
  })

  it('a layout as sent: sections reordered and hidden, panels with widths, a lens; the unlisted sections follow', () => {
    const sent = { sections: [{ id: 'role-panels', hidden: false }, { id: 'needs-me', hidden: false }, { id: 'flow', hidden: true }], panels: [{ id: 'lateOrders', hidden: false, width: 'FULL' }, { id: 'quotesToApprove', hidden: true, width: 'HALF' }], mainLens: 'WORK_ORDERS' }
    expect(layoutProblems(sent)).toEqual([])
    expect(layoutToStore(sent)).toEqual({
      sections: [{ id: 'role-panels', hidden: false }, { id: 'needs-me', hidden: false }, { id: 'flow', hidden: true }, { id: 'focus-strip', hidden: false }],
      panels: [{ id: 'lateOrders', hidden: false, width: 'FULL' }, { id: 'quotesToApprove', hidden: true, width: 'HALF' }],
      mainLens: 'WORK_ORDERS',
    })
  })

  it('refuses, per field: an unknown or doubled section, Needs me now hidden, a doubled or malformed panel, a bad width or lens', () => {
    const problems = layoutProblems({
      sections: [{ id: 'charts', hidden: false }, { id: 'flow', hidden: false }, { id: 'flow', hidden: true }, { id: 'needs-me', hidden: true }],
      panels: [{ id: 'lateOrders', hidden: false, width: 'HALF' }, { id: 'lateOrders', hidden: false, width: 'HALF' }, { id: 'Bad id', hidden: false, width: 'WIDE' }],
      mainLens: 'SHIPMENTS',
    })
    expect(problems.map((problem) => problem.path)).toEqual(['body/sections/0/id', 'body/sections/2/id', 'body/sections/3/hidden', 'body/panels/1/id', 'body/panels/2/id', 'body/panels/2/width', 'body/mainLens'])
  })

  it('a stored layout is read leniently: unknown entries dropped, Needs me now shown, a bad width becomes half', () => {
    expect(layoutOf({ sections: [{ id: 'needs-me', hidden: true }, { id: 'gone' }, 7], panels: [{ id: 'lateOrders', width: 'HUGE' }, { id: 3 }], mainLens: 'NOPE' })).toEqual({
      sections: [{ id: 'needs-me', hidden: false }, { id: 'focus-strip', hidden: false }, { id: 'flow', hidden: false }, { id: 'role-panels', hidden: false }],
      panels: [{ id: 'lateOrders', hidden: false, width: 'HALF' }],
      mainLens: null,
    })
    expect(layoutOf({ sections: 'nonsense', panels: null, mainLens: null })).toEqual(DEFAULT_LAYOUT)
  })
})
