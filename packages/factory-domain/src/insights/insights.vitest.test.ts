import { describe, expect, it } from 'vitest'
import { grainPermission } from '../auth/grains/grains'
import { FACTORY_PERMISSIONS } from '../auth/permissions/catalogue'
import { templateOf } from '../auth/roles/templates'
import type { Actor, Grant, Permission } from '../core/permissions'
import { EVENT_CATALOGUE } from '../events/catalogue'
import {
  ATTENTION_KINDS,
  attentionFor,
  compareItems,
  countsOf,
  groupOf,
  KIND_RULES,
  liveEventsOf,
  matchesScope,
  pageOf,
  parseCursor,
  presentItem,
  sourcesFor,
  tileKindsFor,
  visibleAmounts,
  whyMine,
  type AttentionCandidate,
  type AttentionKind,
  type Viewer,
} from './attention'
import { FLOW_LENSES, LENS_RULES, lensesFor, orderStageOf, stagesOf, invoiceStageOf } from './flow'
import { complianceActs, deadlineSeverity, heldWorkOrderSeverity, hoursUnconfirmed, mailSeverity, openDuties, orderPromiseState, privacySeverity, registerSeverity } from './states'
import { WAITING_RULES, waitingFor, type WaitingCandidate } from './waiting'
import { CODE_WORDS, EN_TEMPLATES, invoiceToIssueWords, mailToSortWords, orderPromiseWords, phrase, render, styleComplianceWords, whyKey, workOrderHeldWords, type Phrase } from './words'

const TENANT = '01900000-0000-7000-8000-000000000001'
const A = '01900000-0000-7000-8000-00000000000a'
const B = '01900000-0000-7000-8000-00000000000b'
const SITE_A = '01900000-0000-7000-8000-0000000000a1'
const P1 = '01900000-0000-7000-8000-0000000000f1'
const ME = '01900000-0000-7000-8000-0000000000e1'
const OTHER = '01900000-0000-7000-8000-0000000000e2'
const NOW = new Date('2026-10-29T09:00:00.000Z')
const TODAY = '2026-10-29'

/** An office actor holding a role template's permissions and grains over these companies. */
function roleActor(key: string, companies: Grant['companies'] = 'all'): Actor {
  const template = templateOf(key)!
  return { audience: 'office', tenantId: TENANT, grants: [{ permissions: [...template.permissions, ...template.grains.map((grain) => grainPermission(grain) as Permission)], companies, sites: 'all', parties: 'all' }] }
}
const viewerOf = (actor: Actor, personId = ME): Viewer => ({ actor, personId, today: TODAY, now: NOW })

let serial = 0
/** A made-up phrase (its English is the text). */
const says = (text: string): Phrase => ({ key: 'test', params: {}, text })
function candidate(kind: AttentionKind, extra: Partial<AttentionCandidate> = {}): AttentionCandidate {
  serial += 1
  const id = `01900000-0000-7000-8000-${String(serial).padStart(12, '0')}`
  return {
    kind,
    state: 'X',
    severity: 'MEDIUM',
    record: { type: 'Thing', id, label: `T-${serial}` },
    scope: { companyId: A, siteId: SITE_A, partyId: P1 },
    sentence: says(`Row ${serial}.`),
    blocks: null,
    due: null,
    since: new Date('2026-10-20T09:00:00.000Z'),
    ...extra,
  }
}

describe('who a row is for (whyMine: the right to act, four eyes, the grain, the company wall)', () => {
  it('the kind’s view AND one of its act permissions over the record; else not shown', () => {
    const lot = candidate('LOT_HOLD', { act: ['quality.lots.release'] })
    expect(whyMine(viewerOf(roleActor('quality_inspector')), lot)?.text).toBe('You release lots at this site.')
    // The buyer sees lots (quality.lots.view) but may not release them: not theirs.
    expect(whyMine(viewerOf(roleActor('buyer')), lot)).toBeNull()
    // Sales sees work orders but does not release them; the planner does.
    const held = candidate('WORK_ORDER_HELD')
    expect(whyMine(viewerOf(roleActor('sales')), held)).toBeNull()
    expect(whyMine(viewerOf(roleActor('planner')), held)?.text).toBe('You release work orders at this site.')
  })

  it('never the person who asked (four eyes), and a margin-floor approval only with the margin grain', () => {
    const asked = candidate('QUOTE_APPROVAL', { notBy: [ME], needsGrain: 'margin' })
    expect(whyMine(viewerOf(roleActor('finance')), asked)).toBeNull()
    expect(whyMine(viewerOf(roleActor('finance'), OTHER), asked)?.text).toMatch(/approve/)
    const noMargin: Actor = { audience: 'office', tenantId: TENANT, grants: [{ permissions: ['quotes.view', 'quotes.approve', 'money.price'], companies: 'all', sites: 'all', parties: 'all' }] }
    expect(whyMine(viewerOf(noMargin, OTHER), asked)).toBeNull()
    expect(whyMine(viewerOf(noMargin, OTHER), candidate('QUOTE_APPROVAL', { notBy: [ME] }))?.text).toMatch(/approve/)
    // The buyer approves no quote at all.
    expect(whyMine(viewerOf(roleActor('buyer'), OTHER), asked)).toBeNull()
  })

  it('a person limited to company A never gets a row of company B', () => {
    const late = candidate('ORDER_PROMISE', { scope: { companyId: B, siteId: null, partyId: P1 } })
    expect(whyMine(viewerOf(roleActor('sales', [A])), late)).toBeNull()
    expect(whyMine(viewerOf(roleActor('sales', [B])), late)?.text).toMatch(/orders/)
  })

  it('a row may name the permissions that act on it (a style: only its blockers’ fixers), and a reason of its own', () => {
    const style = candidate('STYLE_COMPLIANCE', { act: complianceActs(['DECLARATION_OF_CONFORMITY'], KIND_RULES.STYLE_COMPLIANCE.act), scope: { companyId: null, siteId: null, partyId: null } })
    expect(whyMine(viewerOf(roleActor('quality_inspector')), style)?.text).toMatch(/Declarations of Conformity/)
    expect(whyMine(viewerOf(roleActor('production_manager')), style)).toBeNull()
    const entry = candidate('REGISTER_DUTY', { why: (personId) => (personId === ME ? phrase('why.REGISTER_DUTY.follow') : null) })
    expect(whyMine(viewerOf(roleActor('quality_inspector')), entry)?.text).toBe('You follow this entry up.')
    expect(whyMine(viewerOf(roleActor('quality_inspector'), OTHER), entry)?.text).toBe("You keep this company's PPE register.")
  })

  it('the sources a role reads and the tiles it gets', () => {
    expect(tileKindsFor(roleActor('owner'))).toEqual([...ATTENTION_KINDS])
    expect(tileKindsFor(roleActor('buyer'))).toEqual(['PO_PROPOSAL', 'PO_NOT_CONFIRMED', 'MAIL_TO_SORT'])
    expect(sourcesFor(roleActor('buyer'))).toContain('LOT_HOLD') // seen, never acted on
    expect(tileKindsFor(roleActor('quality_inspector'))).toEqual(['LOT_HOLD', 'REGISTER_DUTY', 'STYLE_COMPLIANCE'])
    expect(tileKindsFor(roleActor('sales'))).toEqual(['ORDER_PROMISE', 'MAIL_TO_SORT'])
    expect(tileKindsFor(roleActor('finance'))).toEqual(['INVOICE_SDI', 'QUOTE_APPROVAL', 'INVOICE_TO_ISSUE'])
    expect(tileKindsFor(roleActor('read_only'))).toEqual([])
  })
})

describe('amounts only with their grain (the row and its sentence)', () => {
  const quote = candidate('QUOTE_APPROVAL', { amounts: { currency: 'EUR', netAmount: 624000, marginPct: '18.2500', marginAmount: 113880, inSentence: 'marginPct' }, sentence: says('Quote Q-1 waits.') })
  const po = candidate('PO_NOT_CONFIRMED', { amounts: { currency: 'EUR', purchaseAmount: 120000, inSentence: 'purchaseAmount' }, sentence: says('Purchase order PO-1 is not confirmed.') })

  it('sales (price, margin) sees the margin % and the value, never the margin amount (cost)', () => {
    const item = presentItem(viewerOf(roleActor('sales')), quote, says('why'))
    expect(item.amounts).toEqual({ currency: 'EUR', netAmount: 624000, marginPct: '18.2500' })
    expect(item.sentence).toBe('Quote Q-1 waits (margin 18.3 %).')
    expect(JSON.stringify(item)).not.toContain('113880')
  })

  it('the buyer (cost) sees a purchase order’s value in the row and the sentence; a role without the grain sees neither', () => {
    expect(presentItem(viewerOf(roleActor('buyer')), po, says('why'))).toMatchObject({ amounts: { currency: 'EUR', purchaseAmount: 120000 }, sentence: 'Purchase order PO-1 is not confirmed (EUR 1200.00).' })
    const planner = presentItem(viewerOf(roleActor('planner')), po, says('why'))
    expect(planner.amounts).toBeNull()
    expect(planner.sentence).toBe('Purchase order PO-1 is not confirmed.')
    expect(visibleAmounts(po.amounts, new Set())).toBeNull()
  })
})

describe('rank, groups, pages and tiles', () => {
  const viewer = viewerOf(roleActor('owner'))
  const rows = [
    candidate('ORDER_PROMISE', { severity: 'MEDIUM', due: '2026-10-31' }),
    candidate('LOT_HOLD', { severity: 'HIGH', since: new Date('2026-10-28T09:00:00.000Z') }),
    candidate('LOT_HOLD', { severity: 'HIGH', since: new Date('2026-10-01T09:00:00.000Z') }),
    candidate('ORDER_PROMISE', { severity: 'HIGH', due: '2026-10-25' }),
    candidate('SCAN_REFUSAL', { severity: 'LOW' }),
    candidate('ORDER_PROMISE', { severity: 'MEDIUM', due: null }),
    candidate('QUOTE_APPROVAL', { severity: 'MEDIUM', due: '2026-10-31', since: new Date('2026-10-01T09:00:00.000Z') }),
  ]

  it('severity, then due (none last), then age (oldest first), then key; the same for any input order', () => {
    const ranked = attentionFor(viewer, rows)
    expect(ranked.map((item) => item.record.label)).toEqual([
      rows[3]!.record.label, // HIGH, due 25 Oct
      rows[2]!.record.label, // HIGH, no due, older
      rows[1]!.record.label, // HIGH, no due, newer
      rows[6]!.record.label, // MEDIUM, due 31 Oct, older
      rows[0]!.record.label, // MEDIUM, due 31 Oct, newer
      rows[5]!.record.label, // MEDIUM, no due
      rows[4]!.record.label, // LOW
    ])
    expect(attentionFor(viewer, [...rows].reverse()).map((item) => item.key)).toEqual(ranked.map((item) => item.key))
    expect([...ranked].sort(compareItems)).toEqual(ranked)
  })

  it('groups and due words', () => {
    const ranked = attentionFor(viewer, rows)
    expect(ranked[0]).toMatchObject({ group: 'NOW', due: { date: '2026-10-25', days: -4, word: 'OVERDUE' } })
    expect(ranked.find((item) => item.key.endsWith(rows[0]!.record.id))).toMatchObject({ group: 'THIS_WEEK', due: { days: 2, word: 'SOON' } })
    expect(groupOf('MEDIUM', null)).toBe('TODAY')
    expect(groupOf('LOW', null)).toBe('THIS_WEEK')
    expect(groupOf('MEDIUM', 0)).toBe('TODAY')
    expect(groupOf('LOW', 30)).toBe('LATER')
  })

  it('pages after a cursor never repeat or skip a row, also when a row is decided meanwhile', () => {
    const ranked = attentionFor(viewer, rows)
    const first = pageOf(ranked, null, 3)
    expect(first.items).toHaveLength(3)
    const cursor = parseCursor(first.nextCursor!)!
    const second = pageOf(ranked.filter((item) => item.key !== first.items[1]!.key && item.key !== ranked[4]!.key), cursor, 3)
    expect(second.items.map((item) => item.key)).toEqual([ranked[3]!.key, ranked[5]!.key, ranked[6]!.key])
    expect(second.nextCursor).toBeNull()
    expect(parseCursor('not-a-cursor')).toBeNull()
    expect(parseCursor(Buffer.from('[1,2]').toString('base64url'))).toBeNull()
  })

  it('the tiles: one per kind the person acts on (0 is an answer), each the count of its rows; the total is their sum', () => {
    const ranked = attentionFor(viewer, rows)
    const counts = countsOf(ranked, tileKindsFor(viewer.actor))
    expect(counts.total).toBe(rows.length)
    expect(counts.byKind.reduce((sum, tile) => sum + tile.count, 0)).toBe(counts.total)
    expect(counts.byKind.find((tile) => tile.kind === 'ORDER_PROMISE')!.count).toBe(3)
    expect(counts.byKind.find((tile) => tile.kind === 'PRIVACY_DUTY')!.count).toBe(0)
    expect(counts.byCategory).toEqual({ APPROVAL: 1, ALERT: 6 })
    expect(counts.now).toBe(ranked.filter((item) => item.group === 'NOW').length)
    expect(countsOf([], [])).toEqual({ total: 0, now: 0, byCategory: { APPROVAL: 0, ALERT: 0 }, byKind: [] })
  })

  it('the company and site filters (a site keeps its company’s rows without a site; a shared style belongs to every company)', () => {
    const site = { id: SITE_A, companyId: A }
    expect(matchesScope({ companyId: A, siteId: SITE_A }, { site })).toBe(true)
    expect(matchesScope({ companyId: A, siteId: OTHER }, { site })).toBe(false)
    expect(matchesScope({ companyId: A, siteId: null }, { site })).toBe(true)
    expect(matchesScope({ companyId: B, siteId: null }, { site })).toBe(false)
    expect(matchesScope({ companyId: null, siteId: null }, { companyId: B })).toBe(true)
    expect(matchesScope({ companyId: A, siteId: null }, { companyId: B })).toBe(false)
  })
})

describe('the states that put a record on Today', () => {
  it('orders: late when the promise passed, at risk when due within 3 days and not ready', () => {
    expect(orderPromiseState('IN_PRODUCTION', '2026-10-27', TODAY)).toEqual({ state: 'LATE', days: 2, severity: 'HIGH' })
    expect(orderPromiseState('READY', '2026-10-27', TODAY)).toEqual({ state: 'LATE', days: 2, severity: 'HIGH' })
    expect(orderPromiseState('CONFIRMED', '2026-11-01', TODAY)).toEqual({ state: 'AT_RISK', days: 3, severity: 'MEDIUM' })
    expect(orderPromiseState('READY', '2026-11-01', TODAY)).toBeNull()
    expect(orderPromiseState('CONFIRMED', '2026-11-02', TODAY)).toBeNull()
    expect(orderPromiseState('SHIPPED', '2026-10-01', TODAY)).toBeNull()
    expect(orderPromiseState('CONFIRMED', null, TODAY)).toBeNull()
  })

  it('work orders, purchase orders, invoicing deadlines, the register, privacy', () => {
    expect(heldWorkOrderSeverity('2026-11-01', TODAY)).toBe('HIGH')
    expect(heldWorkOrderSeverity('2026-11-10', TODAY)).toBe('MEDIUM')
    expect(heldWorkOrderSeverity(null, TODAY)).toBe('MEDIUM')
    expect(hoursUnconfirmed(new Date(NOW.getTime() - 47 * 3_600_000), NOW)).toBeNull()
    expect(hoursUnconfirmed(new Date(NOW.getTime() - 50 * 3_600_000), NOW)).toBe(50)
    expect(hoursUnconfirmed(null, NOW)).toBeNull()
    expect([deadlineSeverity('LATE'), deadlineSeverity('DUE_SOON'), deadlineSeverity('OPEN')]).toEqual(['HIGH', 'MEDIUM', 'LOW'])
    const duties = [
      { code: 'RISK_ASSESSMENT' as const, done: true, required: true, law: '' },
      { code: 'CORRECTIVE_ACTION' as const, done: false, required: true, law: '' },
      { code: 'DISTRIBUTORS' as const, done: false, required: false, law: '' },
      { code: 'AUTHORITY' as const, done: false, required: true, law: '' },
    ]
    expect(openDuties(duties)).toEqual(['CORRECTIVE_ACTION', 'AUTHORITY'])
    expect(registerSeverity(['AUTHORITY'])).toBe('HIGH')
    expect(registerSeverity(['CORRECTIVE_ACTION'])).toBe('MEDIUM')
    expect(privacySeverity(['dpia', 'register'])).toBe('HIGH')
    expect(privacySeverity(['publicNotice'])).toBe('MEDIUM')
    expect(complianceActs(['USER_INFORMATION', 'DECLARATION_OF_CONFORMITY', 'CERTIFICATE'], KIND_RULES.STYLE_COMPLIANCE.act)).toEqual(['compliance.declarations.manage', 'compliance.certificates.manage'])
  })

  it('mail to sort: whoever sorts the company’s mail (a mail of no company: every company), never another company’s', () => {
    const mail = candidate('MAIL_TO_SORT', { scope: { companyId: A, siteId: null, partyId: null } })
    expect(whyMine(viewerOf(roleActor('sales')), mail)?.text).toBe("You sort this company's received mail.")
    expect(whyMine(viewerOf(roleActor('sales', [B])), mail)).toBeNull()
    expect(whyMine(viewerOf(roleActor('sales', [B])), candidate('MAIL_TO_SORT', { scope: { companyId: null, siteId: null, partyId: null } }))).not.toBeNull()
    expect(whyMine(viewerOf(roleActor('quality_inspector')), mail)).toBeNull()
    expect([mailSeverity('TRIAGE'), mailSeverity('HELD'), mailSeverity('FAILED')]).toEqual(['MEDIUM', 'MEDIUM', 'LOW'])
    expect(mailToSortWords({ sender: 'Anna Demo', subject: 'Order 200 jackets', state: 'HELD', heldReason: 'DMARC_FAIL' }).sentence.text).toBe(
      '"Order 200 jackets" from Anna Demo is held: its sender\'s address failed the DMARC check.',
    )
    expect(mailToSortWords({ sender: 'a@example.com', subject: null, state: 'TRIAGE', heldReason: null }).sentence).toMatchObject({ key: 'MAIL_TO_SORT.TRIAGE_NO_SUBJECT', params: { sender: 'a@example.com' }, text: 'Mail from a@example.com reached no record: sort it.' })
  })

  it('words name what is held and what waits', () => {
    const held = workOrderHeldWords({ number: 'WO-1', style: 'JKT', checks: ['DEPOSIT', 'MATERIAL'], orders: ['SO-1'] })
    expect(held.sentence).toEqual({ key: 'WORK_ORDER_HELD.HELD', params: { number: 'WO-1', style: 'JKT', count: 2, checks: ['DEPOSIT', 'MATERIAL'] }, text: 'Work order WO-1 (JKT) cannot be released: 2 checks open (deposit, material).' })
    expect(held.blocks).toMatchObject({ key: 'WORK_ORDER_HELD.blocks', text: 'Production of SO-1 waits for it.' })
    expect(styleComplianceWords({ style: 'JKT', checks: ['DECLARATION_OF_CONFORMITY'], steps: ['SHIPPING'], orders: 1, workOrders: 0 }).blocks?.text).toBe('It holds up the shipping of open orders (sales orders: 1, work orders: 0).')
    expect(orderPromiseWords({ number: 'SO-1', customer: 'Shop', state: 'AT_RISK', days: 1, promiseDate: '2026-10-30', toShip: 1 })).toMatchObject({
      sentence: { key: 'ORDER_PROMISE.AT_RISK', params: { count: 1, promiseDate: '2026-10-30' }, text: 'Order SO-1 for Shop is promised for tomorrow (2026-10-30) and is not ready yet.' },
      blocks: { key: 'ORDER_PROMISE.waitsPieces', text: 'Shop waits for 1 piece.' },
    })
    expect(invoiceToIssueWords({ customer: 'Shop', month: '2026-10', ddts: ['1/2026', '2/2026'], docType: 'TD24', dueBy: '2026-11-15', daysLeft: -2 }).blocks).toMatchObject({ key: 'INVOICE_TO_ISSUE.dueLate', params: { count: 2, dueDate: '2026-11-15' } })
    expect(render('listMore', { shown: 'a', count: 3 })).toBe('a and 3 more')
    expect(() => render('NO_SUCH_KEY', {})).toThrow(/no template/)
  })
})

describe('the flow strip', () => {
  it('a role gets the lenses it can see, every stage listed (0 is an answer), late only where a date can pass', () => {
    expect(lensesFor(roleActor('buyer'))).toEqual(['PURCHASE_ORDERS', 'LOTS'])
    expect(lensesFor(roleActor('sales'))).toEqual(['ORDERS', 'WORK_ORDERS', 'INVOICES'])
    expect(lensesFor(roleActor('owner'))).toEqual([...FLOW_LENSES])
    const stages = stagesOf(
      'ORDERS',
      [
        { stage: orderStageOf('CONFIRMED', true), late: true, since: new Date('2026-10-19T09:00:00.000Z') },
        { stage: orderStageOf('CONFIRMED', false), late: false, since: new Date('2026-10-28T09:00:00.000Z') },
        { stage: orderStageOf('IN_PRODUCTION', false), late: false, since: new Date('2026-10-28T09:00:00.000Z') },
        { stage: orderStageOf('CLOSED', false), late: false, since: new Date('2026-01-01T09:00:00.000Z') },
      ],
      NOW,
    )
    expect(stages.map((stage) => [stage.key, stage.count, stage.late, stage.oldestDays])).toEqual([
      ['WAITING_FOR_DEPOSIT', 1, 1, 10],
      ['PLANNED', 1, 0, 1],
      ['IN_PRODUCTION', 1, 0, 1],
      ['READY', 0, 0, null],
      ['PARTLY_SHIPPED', 0, 0, null],
      ['SHIPPED', 0, null, null],
    ])
    expect(stages.find((stage) => stage.key === 'PLANNED')).toMatchObject({ filter: { status: 'CONFIRMED' }, exact: false })
    expect(invoiceStageOf('NOT_DELIVERABLE', true)).toBe('PAID')
    expect(invoiceStageOf('REJECTED', false)).toBe('TO_SEND')
  })
})

describe('waiting on others', () => {
  const asked: WaitingCandidate = {
    kind: 'APPROVAL_REQUEST',
    record: { type: 'Quote', id: A, label: 'Q-1' },
    scope: { companyId: A, siteId: null, partyId: P1 },
    requestedBy: ME,
    sentence: 'Your approval request for quote Q-1 is not decided yet.',
    waitingFor: 'An approver of quotes',
    since: new Date('2026-10-27T09:00:00.000Z'),
    due: null,
    amounts: { currency: 'EUR', netAmount: 624000, marginPct: '18.2500', marginAmount: 113880, inSentence: 'marginPct' },
  }

  it('only what I asked for, while I still see it; amounts by my grains', () => {
    const mine = waitingFor(viewerOf(roleActor('sales')), [asked, { ...asked, record: { ...asked.record, id: B }, requestedBy: OTHER }])
    expect(mine).toHaveLength(1)
    expect(mine[0]).toMatchObject({ ageDays: 2, amounts: { currency: 'EUR', netAmount: 624000, marginPct: '18.2500' }, sentence: 'Your approval request for quote Q-1 is not decided yet (margin 18.3 %).' })
    expect(mine[0]!.amounts).not.toHaveProperty('marginAmount')
    expect(waitingFor(viewerOf(roleActor('sales', [B])), [asked])).toEqual([])
    expect(waitingFor(viewerOf(roleActor('buyer')), [asked])).toEqual([])
  })
})

describe('the catalogue', () => {
  it('every permission a kind, a lens or a waiting row names is declared, and every event it refreshes on too', () => {
    const permissions = [
      ...ATTENTION_KINDS.flatMap((kind) => [KIND_RULES[kind].view, ...KIND_RULES[kind].act]),
      ...FLOW_LENSES.map((lens) => LENS_RULES[lens].view),
      ...Object.values(WAITING_RULES).map((rule) => rule.view),
      'home.view',
    ]
    expect(permissions.filter((permission) => !FACTORY_PERMISSIONS.isDeclared(permission))).toEqual([])
    const events = [...liveEventsOf([...ATTENTION_KINDS]), ...FLOW_LENSES.flatMap((lens) => LENS_RULES[lens].live), ...Object.values(WAITING_RULES).flatMap((rule) => rule.live)]
    // Declared, and streamed to live screens (GET /live): the web refreshes on them.
    expect(events.filter((type) => !EVENT_CATALOGUE.find(type, 1)?.live)).toEqual([])
    for (const kind of ATTENTION_KINDS) for (const permission of KIND_RULES[kind].act) expect(EN_TEMPLATES[whyKey(kind, permission)], `${kind} ${permission}`).toBeTruthy()
    // The design's tiles: Approvals are exactly the decisions a person reviews; everything else is an alert.
    for (const kind of ATTENTION_KINDS) expect(KIND_RULES[kind].category, kind).toBe(KIND_RULES[kind].decide === 'REVIEW' ? 'APPROVAL' : 'ALERT')
    expect(Object.keys(CODE_WORDS).sort()).toEqual(['checks', 'complianceChecks', 'duties', 'entryKind', 'heldReason', 'privacyDuties', 'reasons', 'steps'])
  })

  it('every office template that works on records has home.view; floor roles never do', () => {
    for (const key of ['owner', 'admin', 'finance', 'sales', 'planner', 'buyer', 'warehouse', 'production_manager', 'quality_inspector', 'floor_supervisor', 'read_only']) {
      expect(templateOf(key)!.permissions, key).toContain('home.view')
    }
    for (const key of ['operator', 'cutting_operator', 'floor_inspector', 'team_leader']) expect(templateOf(key)!.permissions).not.toContain('home.view')
  })
})
