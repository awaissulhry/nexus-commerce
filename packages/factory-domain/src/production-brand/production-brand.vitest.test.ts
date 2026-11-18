import { describe, expect, it } from 'vitest'
import { FACTORY_PERMISSIONS } from '../auth/permissions/catalogue'
import { PARTNER_ROLE_TEMPLATES, partnerTemplateOf, ROLE_TEMPLATES, templateOf } from '../auth/roles/templates'
import { PROMISE_REASON_CODES } from '../sales/portal-orders/promise'
import { groupOf, maySee, PORTAL_DOCUMENT_KINDS, type DocumentAccess } from '../sales/portal-documents/library'
import { PORTAL_CUSTOMER_DOCUMENTS_CONFORMITY, PORTAL_CUSTOMER_DOCUMENTS_FINANCE, PORTAL_CUSTOMER_DOCUMENTS_VIEW } from '../sales/portal-documents/permissions'
import { freezeVerdict, rulesForParty, type FreezeRuleFacts } from '../sales/order-changes/freeze'
import { computedHealth, effectiveHealth, HEALTH_REASON_CODES, raiseProblems, raiseStands, raiseUntil, type BrandHealth } from './health'
import { askKindsProblems, isAskOpen, openAskKinds, PRODUCTION_REQUEST_KINDS } from './kinds'
import { maskByLevel, maskOf, PRODUCTION_SHARE_LEVELS, qualityResultsShown, shares } from './levels'
import { CUSTOMER_PRODUCTION_ROLE } from './permissions'
import { BRAND_STAGES, lineStageOf, movedForward, orderStageOf, type LineStageFacts } from './stages'
import { BLOCKER_KINDS, BLOCKER_OWNER, brandSideOf, waitingOn, WAITING_ON } from './waiting'
import { aheadWords, ASK_KIND_WORDS, ASK_NOT_OPEN_WORDS, BRAND_WAITING_WORDS, HEALTH_REASON_WORDS, HEALTH_WORDS, LEVEL_WORDS, OFFICE_WAITING_WORDS, SEWING_NOT_COUNTED_WORDS, STAGE_WORDS } from './words'
// B-PR-41
import { workingCalendar, type CalendarLayer } from '../calendars/working-time'
import type { Actor, Grant, Permission } from '../core/permissions'
import { backupProblems, effectiveSupervisor, escalationClock, escalationStepAt, escalationStepsDue, supervisorMarkOf, supervisorProblems, supervisorRefusals, workOrderSupervisor, type EscalationClock, type SupervisorCandidate } from './supervisor'
import { brandList, listCompare, markDecision, moveToTop, newMarkRank, undoPlan, urgentMaxProblems, urgentOrderProblems, usedOf, URGENT_MAX, type MarkFacts, type UrgencyRow } from './urgency'
import {
  ASK_US_WORDS,
  askUsWords,
  CHANGED_BY_US_WORDS,
  CHANGED_SINCE_WORDS,
  CUSTOMER_URGENCY_WORDS,
  dormantMarksWords,
  ESCALATION_WORDS,
  MARK_URGENT_FIRST_WORDS,
  NOT_IN_PRODUCTION_WORDS,
  overQuotaWords,
  PRODUCTION_ROLE_NOT_OFFERED_WORDS,
  setBackWords,
  SUPERVISOR_MARK_WORDS,
  SUPERVISOR_REFUSAL_WORDS,
  SUPERVISOR_WORDS,
  unchangedWords,
  URGENCY_NOT_OPEN_WORDS,
  URGENCY_WORDS,
  urgentUsedWords,
} from './words'
// B-PR-22a
import { placeInUrgentList, ranksOf, URGENCY_OUTCOMES } from './urgency'
// B-PR-22b
import { lockReasonProblems, URGENCY_LOCK_REASON_MAX, URGENCY_OFFICE_BATCH_MAX } from './urgency'
import { ALREADY_LOCKED_WORDS, customerUrgencyChipWords, NO_OVERRIDE_RIGHT_WORDS, NOT_LOCKED_WORDS } from './words'
import { changedAtWords, changedByUsAtWords, NOT_KEPT_YET_WORDS, NOTHING_TO_UNDO_WORDS, NOTHING_UNDONE_WORDS, ORDER_NOT_FOUND_WORDS, URGENT_ORDER_UNCHANGED_WORDS } from './words'

const line = (facts: Partial<LineStageFacts> = {}): LineStageFacts => ({ reached: null, allReleased: false, done: false, sewingCounted: true, ...facts })

describe('B-PR-13 share levels and their masks', () => {
  it('STATUS masks progress, gates and quality; each level adds to the one before (wall: a section not shared is not drawn)', () => {
    expect(maskOf('STATUS')).toEqual({ progress: false, gates: false, quality: false })
    expect(maskOf('PROGRESS')).toEqual({ progress: true, gates: false, quality: false })
    expect(maskOf('GATES')).toEqual({ progress: true, gates: true, quality: false })
    expect(maskOf('QUALITY')).toEqual({ progress: true, gates: true, quality: true })
    // B-PR-40: production progress is the level's alone (the old progressShared switch dropped): from PROGRESS on.
    expect(PRODUCTION_SHARE_LEVELS.filter((level) => shares(level, 'progress'))).toEqual(['PROGRESS', 'GATES', 'QUALITY'])
  })

  it('a section the level hides leaves the read as null even when it was read; every other key passes', () => {
    const read = { stage: 'SEWING', health: 'ON_TRACK', progress: { cut: 40 }, gates: [{ kind: 'PP_SAMPLE' }], quality: { released: 10 } }
    expect(maskByLevel('STATUS', read)).toEqual({ stage: 'SEWING', health: 'ON_TRACK', progress: null, gates: null, quality: null })
    expect(maskByLevel('GATES', read)).toEqual({ ...read, quality: null })
    expect(maskByLevel('QUALITY', read)).toEqual(read)
    expect(maskByLevel('STATUS', { stage: 'CUTTING' })).toEqual({ stage: 'CUTTING' })
  })

  it('inspection results only at QUALITY and only of a work order that is that customer\'s alone', () => {
    expect(qualityResultsShown('QUALITY', 'party-a', 'party-a')).toBe(true)
    expect(qualityResultsShown('QUALITY', null, 'party-a')).toBe(false)
    expect(qualityResultsShown('QUALITY', 'party-b', 'party-a')).toBe(false)
    expect(qualityResultsShown('GATES', 'party-a', 'party-a')).toBe(false)
  })
})

describe('B-PR-13 the five plain stages', () => {
  it('a line reads its furthest real stage; all released is READY; a done line no longer counts', () => {
    expect(lineStageOf(line())).toBe('PREPARING')
    expect(lineStageOf(line({ reached: 'RELEASED' }))).toBe('PREPARING')
    expect(lineStageOf(line({ reached: 'CUT' }))).toBe('CUTTING')
    expect(lineStageOf(line({ reached: 'SEWING' }))).toBe('SEWING')
    expect(lineStageOf(line({ reached: 'FINISHED' }))).toBe('QUALITY')
    expect(lineStageOf(line({ reached: 'SHIPPED' }))).toBe('QUALITY')
    expect(lineStageOf(line({ reached: 'FINISHED', allReleased: true }))).toBe('READY')
    expect(lineStageOf(line({ reached: 'SHIPPED', done: true }))).toBeNull()
    expect(BRAND_STAGES).toEqual(['PREPARING', 'CUTTING', 'SEWING', 'QUALITY', 'READY'])
  })

  it('the order shows its slowest unfinished line and how many of its lines are ahead', () => {
    expect(orderStageOf([line({ reached: 'SEWING' }), line({ reached: 'CUT' }), line({ reached: 'FINISHED' })])).toEqual({ stage: 'CUTTING', ahead: 2, next: 'SEWING', sewingNotCounted: false })
    expect(orderStageOf([line({ reached: 'SEWING' }), line({ reached: 'SEWING' })])).toMatchObject({ stage: 'SEWING', ahead: 0, next: 'QUALITY' })
    expect(orderStageOf([line({ reached: 'FINISHED', allReleased: true })])).toMatchObject({ stage: 'READY', next: null })
  })

  it('a partly shipped order: shipped lines leave, the open lines read READY once all their pieces are released; nothing open: no stage', () => {
    expect(orderStageOf([line({ reached: 'SHIPPED', done: true }), line({ reached: 'FINISHED', allReleased: true })])).toMatchObject({ stage: 'READY', ahead: 0 })
    expect(orderStageOf([line({ reached: 'SHIPPED', done: true }), line({ done: true })])).toBeNull()
    expect(orderStageOf([])).toBeNull()
  })

  it('where a site does not scan sewing the order at CUTTING says so', () => {
    expect(orderStageOf([line({ reached: 'CUT', sewingCounted: false })])?.sewingNotCounted).toBe(true)
    expect(orderStageOf([line({ reached: 'CUT', sewingCounted: true }), line({ reached: 'FINISHED', sewingCounted: false })])?.sewingNotCounted).toBe(false)
    expect(orderStageOf([line({ reached: 'FINISHED', sewingCounted: false })])?.sewingNotCounted).toBe(false)
  })

  it('a stage notice goes only forward', () => {
    expect(movedForward(null, 'PREPARING')).toBe(true)
    expect(movedForward('CUTTING', 'SEWING')).toBe(true)
    expect(movedForward('SEWING', 'CUTTING')).toBe(false)
    expect(movedForward('SEWING', 'SEWING')).toBe(false)
    expect(movedForward('READY', null)).toBe(false)
  })
})

describe('B-PR-13 health: computed, and a raise that never lowers it', () => {
  it('the worst open line wins; a gate past its target makes a better state at risk; nothing open: no health', () => {
    expect(computedHealth({ lineRisks: ['ON_TIME', 'LATE', null], gateOverdue: false })).toBe('LATE')
    expect(computedHealth({ lineRisks: ['ON_TIME', 'NOT_PROMISED'], gateOverdue: false })).toBe('NO_DATE')
    expect(computedHealth({ lineRisks: ['ON_TIME'], gateOverdue: false })).toBe('ON_TRACK')
    expect(computedHealth({ lineRisks: ['ON_TIME'], gateOverdue: true })).toBe('AT_RISK')
    expect(computedHealth({ lineRisks: ['NOT_PROMISED'], gateOverdue: true })).toBe('AT_RISK')
    expect(computedHealth({ lineRisks: ['LATE'], gateOverdue: true })).toBe('LATE')
    expect(computedHealth({ lineRisks: [null, null], gateOverdue: true })).toBeNull()
  })

  it('a raise is to At risk only, from a better state, with a curated reason and a short office note', () => {
    expect(raiseProblems({ computed: 'ON_TRACK', reasonCode: 'MATERIAL_LATE', note: 'tannery batch late' })).toEqual([])
    expect(raiseProblems({ computed: 'NO_DATE', reasonCode: 'PLANNING' })).toEqual([])
    expect(raiseProblems({ computed: 'LATE', reasonCode: 'CAPACITY' })[0]?.message).toMatch(/already late/)
    expect(raiseProblems({ computed: 'AT_RISK', reasonCode: 'CAPACITY' })[0]?.message).toMatch(/already at risk/)
    expect(raiseProblems({ computed: null, reasonCode: 'CAPACITY' })[0]?.message).toMatch(/Nothing is left/)
    expect(raiseProblems({ computed: 'ON_TRACK', reasonCode: 'EARLIER' })).toEqual([{ path: 'body/reasonCode', message: expect.stringMatching(/Expected one of/) }])
    expect(raiseProblems({ computed: 'ON_TRACK', reasonCode: 'QUALITY', note: 'x'.repeat(201) })[0]?.path).toBe('body/note')
    expect(raiseProblems({ computed: 'ON_TRACK', reasonCode: 'QUALITY', note: 'two\nlines' })[0]?.path).toBe('body/note')
    // The curated list is the promise's own, but for "ready earlier than planned".
    expect(HEALTH_REASON_CODES.every((code) => (PROMISE_REASON_CODES as readonly string[]).includes(code))).toBe(true)
    expect(HEALTH_REASON_CODES).not.toContain('EARLIER')
  })

  it('the customer reads a standing raise as At risk with its reason, never a lower health than computed', () => {
    const raise = { reasonCode: 'TRANSPORT' as const, until: raiseUntil('2026-11-17') }
    expect(raise.until).toBe('2026-11-24')
    expect(effectiveHealth('ON_TRACK', raise)).toEqual({ health: 'AT_RISK', reasonCode: 'TRANSPORT', raised: true })
    expect(effectiveHealth('NO_DATE', raise)).toEqual({ health: 'AT_RISK', reasonCode: 'TRANSPORT', raised: true })
    expect(effectiveHealth('LATE', raise)).toEqual({ health: 'LATE', reasonCode: null, raised: false })
    expect(effectiveHealth('ON_TRACK', null)).toEqual({ health: 'ON_TRACK', reasonCode: null, raised: false })
    expect(effectiveHealth(null, raise)).toEqual({ health: null, reasonCode: null, raised: false })
  })

  it('a raise drops after 7 days or as soon as the computed health changes', () => {
    const raise = { reasonCode: 'CAPACITY' as const, until: raiseUntil('2026-11-17') }
    const same = { computedBefore: 'ON_TRACK' as BrandHealth, computedNow: 'ON_TRACK' as BrandHealth }
    expect(raiseStands(raise, { ...same, today: '2026-11-23' })).toBe(true)
    expect(raiseStands(raise, { ...same, today: '2026-11-24' })).toBe(false)
    expect(raiseStands(raise, { computedBefore: 'ON_TRACK', computedNow: 'NO_DATE', today: '2026-11-18' })).toBe(false)
    expect(raiseStands(raise, { computedBefore: 'ON_TRACK', computedNow: 'LATE', today: '2026-11-18' })).toBe(false)
  })
})

describe('B-PR-13 waiting on: the customer reads only you or us', () => {
  const at = (iso: string) => new Date(iso)

  it('the first owner with a blocker wins (customer, supplier, workshop, us), since its earliest blocker; none: us', () => {
    expect(waitingOn([{ kind: 'SUBCONTRACT', since: at('2026-11-01T08:00:00Z') }, { kind: 'APPROVAL', since: at('2026-11-10T08:00:00Z') }, { kind: 'DEPOSIT', since: at('2026-11-05T08:00:00Z') }])).toEqual({ on: 'BRAND', since: at('2026-11-05T08:00:00Z') })
    expect(waitingOn([{ kind: 'BRAND_REQUEST', since: null }, { kind: 'MATERIAL_SHORT', since: at('2026-11-02T08:00:00Z') }, { kind: 'SUBCONTRACT', since: null }])).toEqual({ on: 'SUPPLIER', since: at('2026-11-02T08:00:00Z') })
    expect(waitingOn([{ kind: 'QUALITY_HOLD', since: null }, { kind: 'SUBCONTRACT', since: null }])).toEqual({ on: 'WORKSHOP', since: null })
    expect(waitingOn([{ kind: 'BRAND_REQUEST', since: at('2026-11-03T08:00:00Z') }])).toEqual({ on: 'US', since: at('2026-11-03T08:00:00Z') })
    expect(waitingOn([])).toEqual({ on: 'US', since: null })
  })

  it('every blocker has an owner; a supplier or a workshop reads to the customer as us (wall: never named)', () => {
    for (const kind of BLOCKER_KINDS) expect(WAITING_ON).toContain(BLOCKER_OWNER[kind])
    expect(WAITING_ON.map(brandSideOf)).toEqual(['YOU', 'US', 'US', 'US'])
  })
})

describe('B-PR-13 production asks open to a customer', () => {
  it('RUSH opens exactly with the urgency switch, never through the list; the others exactly through the list', () => {
    expect(isAskOpen('RUSH', { productionUrgencyOn: true, productionAskKinds: [] })).toBe(true)
    expect(isAskOpen('RUSH', { productionUrgencyOn: false, productionAskKinds: ['RUSH', 'HOLD'] })).toBe(false)
    expect(isAskOpen('HOLD', { productionUrgencyOn: true, productionAskKinds: [] })).toBe(false)
    expect(isAskOpen('HOLD', { productionUrgencyOn: false, productionAskKinds: ['HOLD'] })).toBe(true)
    expect(openAskKinds({ productionUrgencyOn: false, productionAskKinds: [] })).toEqual([])
    expect(openAskKinds({ productionUrgencyOn: true, productionAskKinds: ['SAMPLE_ROUND', 'HOLD', 'RESUME', 'SPLIT_SHIPMENT'] })).toEqual([...PRODUCTION_REQUEST_KINDS])
  })

  it('the limits card lists only the four production asks, each once, in words', () => {
    expect(askKindsProblems(['HOLD', 'RESUME'])).toEqual([])
    expect(askKindsProblems(['HOLD', 'HOLD'])).toEqual([{ path: 'body/productionAskKinds', message: 'An ask is listed twice.' }])
    expect(askKindsProblems(['RUSH'])[0]?.message).toMatch(/urgency switch/)
    expect(askKindsProblems(['CANCEL'])[0]?.message).toMatch(/cut-offs/)
    expect(askKindsProblems(['SHIP'])).toEqual([{ path: 'body/productionAskKinds/0', message: 'Expected one of HOLD, RESUME, SPLIT_SHIPMENT, SAMPLE_ROUND.' }])
  })
})

describe('B-PR-13 freeze rules per customer (rulesForParty)', () => {
  type Rule = FreezeRuleFacts & { readonly partyId: string | null }
  const rule = (id: string, partyId: string | null, facts: Partial<FreezeRuleFacts> = {}): Rule => ({ id, partyId, field: 'SIZE_QUANTITY', frozenFrom: 'CUT', action: 'CHANGE_REQUEST', active: true, note: null, ...facts })
  const company = rule('company-size', null)
  const companyDate = rule('company-date', null, { field: 'DELIVERY_DATE', frozenFrom: 'SEWING', action: 'BLOCKED' })
  const alpha = rule('alpha-size', 'party-a', { frozenFrom: 'RELEASED', action: 'BLOCKED' })
  const beta = rule('beta-date', 'party-b', { field: 'DELIVERY_DATE', frozenFrom: 'RELEASED', action: 'BLOCKED' })
  const rules = [company, companyDate, alpha, beta]

  it("a customer's active rules of a field replace the company's for that field; the company's decide the rest", () => {
    expect(rulesForParty(rules, 'party-a').map((entry) => entry.id)).toEqual(['company-date', 'alpha-size'])
    expect(freezeVerdict(rulesForParty(rules, 'party-a'), 'SIZE_QUANTITY', 'RELEASED').state).toBe('BLOCKED')
    expect(freezeVerdict(rulesForParty(rules, 'party-a'), 'DELIVERY_DATE', 'RELEASED').state).toBe('OPEN')
  })

  it("another customer's rules never decide (wall); without a set of its own, or for the company, the company's rules decide", () => {
    expect(rulesForParty(rules, 'party-c').map((entry) => entry.id)).toEqual(['company-size', 'company-date'])
    expect(rulesForParty(rules, null).map((entry) => entry.id)).toEqual(['company-size', 'company-date'])
    expect(rulesForParty(rules, 'party-a').some((entry) => entry.partyId === 'party-b')).toBe(false)
    expect(freezeVerdict(rulesForParty(rules, 'party-a'), 'DELIVERY_DATE', 'SEWING').ruleId).toBe('company-date')
  })

  it("an inactive rule of the customer's does not replace the company's", () => {
    const resting = rule('alpha-resting', 'party-a', { active: false })
    expect(rulesForParty([company, resting], 'party-a').map((entry) => entry.id)).toEqual(['company-size'])
  })
})

describe('B-PR-13 the permissions in the catalogue and the office templates', () => {
  const office = ['partners.production.manage', 'production.brand.manage', 'production.brand.override', 'workorders.hold'] as const
  const holds = (key: string, permission: string) => templateOf(key)!.permissions.includes(permission as never)

  it('declares the office four with their risk and the portal two flagged partner', () => {
    expect(office.map((name) => FACTORY_PERMISSIONS.get(name)?.risk)).toEqual(['stepUp', 'write', 'stepUp', 'write'])
    for (const name of office) expect(FACTORY_PERMISSIONS.assignable.some((definition) => definition.name === name)).toBe(true)
    for (const name of ['portal.production.view', 'portal.production.urgency']) {
      expect(FACTORY_PERMISSIONS.get(name)?.partner).toBe(true)
      expect(FACTORY_PERMISSIONS.assignable.some((definition) => definition.name === name)).toBe(false)
    }
    expect(FACTORY_PERMISSIONS.get('portal.production.urgency')?.risk).toBe('write')
    expect(FACTORY_PERMISSIONS.isDeclared('portal.production.rank')).toBe(false)
  })

  it('gives them to the office roles the plan names, and to no other', () => {
    const who = (permission: string) => ROLE_TEMPLATES.filter((entry) => entry.permissions.includes(permission as never)).map((entry) => entry.key).sort()
    expect(who('partners.production.manage')).toEqual(['admin', 'owner', 'production_manager', 'sales'])
    expect(who('production.brand.manage')).toEqual(['admin', 'owner', 'planner', 'production_manager'])
    expect(who('production.brand.override')).toEqual(['admin', 'owner', 'production_manager'])
    expect(who('workorders.hold')).toEqual(['owner', 'planner', 'production_manager'])
    expect(holds('production_manager', 'partners.view')).toBe(true)
    for (const entry of ROLE_TEMPLATES) expect(entry.permissions.filter((permission) => permission.startsWith('portal.production')), entry.key).toEqual([])
  })
})

describe('B-PR-13 the customer Production role and production for the other customer roles', () => {
  const role = (key: string) => partnerTemplateOf(key)!
  const has = (key: string, permission: string) => role(key).permissions.includes(permission as never)

  // B-PR-25: the Production role asks (portal.salesOrders.ask) from B-PR-25 on; still no price grain.
  it('the Production role: its orders and their production, urgency, asks, approvals, samples, shared files and messages; no price grain', () => {
    const production = role(CUSTOMER_PRODUCTION_ROLE)
    expect(production).toMatchObject({ kind: 'CUSTOMER', admin: false, name: 'Production', grains: [] })
    for (const permission of ['portal.home.view', 'portal.search', 'portal.salesOrders.view', 'portal.approvals.view', 'portal.samples.view', 'portal.customerDocuments.view', 'portal.comment', 'portal.production.view', 'portal.production.urgency', 'portal.salesOrders.ask']) {
      expect(has(CUSTOMER_PRODUCTION_ROLE, permission), permission).toBe(true)
    }
    for (const permission of ['portal.customerDocuments.finance', 'portal.customerDocuments.conformity', 'portal.orderRequests.manage', 'portal.payments.view', 'portal.colleagues.manage']) {
      expect(has(CUSTOMER_PRODUCTION_ROLE, permission), permission).toBe(false)
    }
    expect(production.capabilities.allowed).toEqual(['comment', 'upload', 'approve'])
  })

  it('Buyer and Admin mark orders urgent; Quality and Viewer read production; Designer and Finance do not see it', () => {
    for (const key of ['customer-buyer', 'customer-admin']) expect([has(key, 'portal.production.view'), has(key, 'portal.production.urgency')], key).toEqual([true, true])
    for (const key of ['customer-quality', 'customer-viewer']) expect([has(key, 'portal.production.view'), has(key, 'portal.production.urgency')], key).toEqual([true, false])
    for (const key of ['customer-designer', 'customer-finance']) expect([has(key, 'portal.production.view'), has(key, 'portal.production.urgency')], key).toEqual([false, false])
    // Never a supplier, workshop or guest role.
    for (const entry of PARTNER_ROLE_TEMPLATES.filter((template) => template.kind !== 'CUSTOMER')) expect(entry.permissions.some((permission) => permission.startsWith('portal.production')), entry.key).toBe(false)
  })

  it("wall (PW-12 pure, R-52): the Production role's library gives the order's shared files but no order confirmation, quote, conformity or finance document", () => {
    const production = role(CUSTOMER_PRODUCTION_ROLE)
    const access: DocumentAccess = {
      view: production.permissions.includes(PORTAL_CUSTOMER_DOCUMENTS_VIEW),
      conformity: production.permissions.includes(PORTAL_CUSTOMER_DOCUMENTS_CONFORMITY),
      finance: production.permissions.includes(PORTAL_CUSTOMER_DOCUMENTS_FINANCE),
      price: production.grains.includes('price'),
    }
    expect(access).toEqual({ view: true, conformity: false, finance: false, price: false })
    const seen = PORTAL_DOCUMENT_KINDS.filter((kind) => maySee(access, groupOf(kind)))
    expect(seen).toContain('OTHER')
    expect(seen).toContain('DDT')
    expect(seen).not.toContain('ORDER_CONFIRMATION')
    expect(seen).not.toContain('QUOTE')
    expect(seen.map(groupOf).filter((group) => group === 'CONFORMITY' || group === 'FINANCE' || group === 'ORDERS')).toEqual([])
  })
})

describe('B-PR-13 the words', () => {
  const brandWords = [
    ...Object.values(STAGE_WORDS),
    SEWING_NOT_COUNTED_WORDS,
    aheadWords(1)!,
    aheadWords(3)!,
    ...Object.values(HEALTH_WORDS),
    ...Object.values(HEALTH_REASON_WORDS),
    ...Object.values(BRAND_WAITING_WORDS),
    ...Object.values(LEVEL_WORDS),
    ...Object.values(ASK_KIND_WORDS),
    ASK_NOT_OPEN_WORDS,
  ]

  it('every word in Italian and English', () => {
    for (const words of [...brandWords, ...Object.values(OFFICE_WAITING_WORDS)]) {
      expect(words.it.trim()).not.toBe('')
      expect(words.en.trim()).not.toBe('')
    }
    expect(Object.keys(STAGE_WORDS)).toEqual([...BRAND_STAGES])
    expect(aheadWords(0)).toBeNull()
    expect(aheadWords(2)).toEqual({ it: '2 righe più avanti', en: '2 lines ahead' })
  })

  it('wall: the words a customer reads never name a supplier, a workshop, a worker, a station, a production line, capacity of a line or another customer, and take no name', () => {
    const forbidden = /supplier|workshop|worker|operator|station|production line|another customer|other customer|fornitor|laborator|operai|postazion|linea di produzione|altro cliente|altri clienti|\{/i
    for (const words of brandWords) {
      expect(words.en, words.en).not.toMatch(forbidden)
      expect(words.it, words.it).not.toMatch(forbidden)
    }
    // A supplier or a workshop reads to the customer as us.
    expect(BRAND_WAITING_WORDS[brandSideOf('SUPPLIER')]).toEqual(BRAND_WAITING_WORDS.US)
    expect(BRAND_WAITING_WORDS[brandSideOf('WORKSHOP')]).toEqual(BRAND_WAITING_WORDS.US)
  })
})

// ---- B-PR-41: customer urgency and the production supervisor ---------------------------------------------------------------

const A = 'party-a'
const B = 'party-b'
const urgencyRow = (orderId: string, over: Partial<UrgencyRow> = {}): UrgencyRow => ({
  orderId,
  partyId: A,
  number: orderId.toUpperCase(),
  orderDate: '2026-11-01',
  createdAt: new Date('2026-11-01T09:00:00Z'),
  urgency: 'REGULAR',
  urgentRank: null,
  setBy: null,
  locked: false,
  lockReason: null,
  open: true,
  ...over,
})
const urgent = (orderId: string, rank: number, over: Partial<UrgencyRow> = {}) => urgencyRow(orderId, { urgency: 'URGENT', urgentRank: rank, setBy: 'BRAND', ...over })

describe('B-PR-41 customer urgency: the list and the quota', () => {
  const rows = [
    urgencyRow('so-new', { orderDate: '2026-11-10' }),
    urgent('so-u2', 2, { orderDate: '2026-09-01' }),
    urgencyRow('so-old', { orderDate: '2026-10-01' }),
    urgencyRow('so-same-later', { createdAt: new Date('2026-11-01T11:00:00Z') }),
    urgent('so-u1', 1, { orderDate: '2026-11-15' }),
    urgencyRow('so-same-earlier', { createdAt: new Date('2026-11-01T08:00:00Z') }),
    urgencyRow('so-shipped', { orderDate: '2026-08-01', open: false }),
  ]

  it('Urgent first in the customer\'s own order, then Regular by date sent (oldest first), when made, number; a closed order leaves the list', () => {
    expect(brandList(rows, { partyId: A, urgencyOn: true }).map((row) => row.orderId)).toEqual(['so-u1', 'so-u2', 'so-old', 'so-same-earlier', 'so-same-later', 'so-new'])
    expect(listCompare(urgent('x', 1), urgencyRow('y', { orderDate: '2020-01-01' }))).toBeLessThan(0)
    // Same date and time: the number decides.
    expect(brandList([urgencyRow('b'), urgencyRow('a')], { partyId: A, urgencyOn: true }).map((row) => row.number)).toEqual(['A', 'B'])
  })

  it('with the switch off the marks are kept but order nothing: every order by date sent (R-46)', () => {
    expect(brandList(rows, { partyId: A, urgencyOn: false }).map((row) => row.orderId)).toEqual(['so-u2', 'so-old', 'so-same-earlier', 'so-same-later', 'so-new', 'so-u1'])
    expect(rows.filter((row) => row.urgency === 'URGENT')).toHaveLength(2)
  })

  it('"n of max used" counts only the customer\'s own open urgent orders; above the quota after an agreed ask "4 of 3 · 1 agreed with us"', () => {
    expect(usedOf(rows, { partyId: A, max: 3 })).toEqual({ used: 2, max: 3, agreed: 0, left: 1, over: false })
    expect(urgentUsedWords(usedOf(rows, { partyId: A, max: 3 }))).toEqual({ it: '2 urgenti su 3', en: '2 of 3 urgent used' })
    const agreed = [urgent('a1', 1), urgent('a2', 2), urgent('a3', 3), urgent('a4', 4, { setBy: 'FACTORY' }), urgent('closed', 5, { open: false })]
    const use = usedOf(agreed, { partyId: A, max: 3 })
    expect(use).toEqual({ used: 4, max: 3, agreed: 1, left: 0, over: true })
    expect(urgentUsedWords(use)).toEqual({ it: '4 urgenti su 3 · 1 concordato con noi', en: '4 of 3 · 1 agreed with us' })
    expect(newMarkRank(rows, A)).toBe(3)
  })

  it("wall (PW-11 pure): a list or a count given another customer's order throws; no field carries a place or another customer's count", () => {
    const foreign = [...rows, urgent('so-b', 1, { partyId: B })]
    expect(() => brandList(foreign, { partyId: A, urgencyOn: true })).toThrow(/another customer/)
    expect(() => usedOf(foreign, { partyId: A, max: 3 })).toThrow(/another customer/)
    expect(() => moveToTop(foreign, { partyId: A, orderId: 'so-u2' })).toThrow(/another customer/)
    expect(() => urgentOrderProblems(foreign, { partyId: A, urgencyOn: true, orderIds: ['so-u1', 'so-u2'] })).toThrow(/another customer/)
    expect(Object.keys(usedOf(rows, { partyId: A, max: 3 })).sort()).toEqual(['agreed', 'left', 'max', 'over', 'used'])
    expect(JSON.stringify(urgentUsedWords({ used: 4, max: 3, agreed: 1 }))).not.toMatch(/place|position|posto|posizione|queue|coda|other|altr/i)
  })

  it('the quota is a whole number from 0 to 20, 3 by default', () => {
    expect(URGENT_MAX).toEqual({ min: 0, max: 20, byDefault: 3 })
    for (const ok of [0, 3, 20]) expect(urgentMaxProblems(ok)).toEqual([])
    for (const no of [-1, 21, 2.5, '3', null]) expect(urgentMaxProblems(no)).toEqual([{ path: 'body/productionUrgentMax', message: 'The urgent quota is a whole number from 0 to 20.' }])
  })
})

describe('B-PR-41 the mark: at once inside the quota and before Cutting (live cut facts), else an ask', () => {
  const facts = (over: Partial<MarkFacts> = {}): MarkFacts => ({ urgencyOn: true, max: 3, row: urgencyRow('so-1'), used: 2, cut: null, ...over })

  it('inside the quota and nothing cut: at once', () => {
    expect(markDecision('URGENT', facts())).toEqual({ outcome: 'AT_ONCE' })
  })

  it('over the quota, or with a cut logged or a bundle made (read live), it becomes an ask ("Ask us")', () => {
    expect(markDecision('URGENT', facts({ used: 3 }))).toEqual({ outcome: 'ASK', reason: 'OVER_QUOTA', words: askUsWords('OVER_QUOTA', 3) })
    expect(markDecision('URGENT', facts({ max: 0, used: 0 }))).toMatchObject({ outcome: 'ASK', reason: 'OVER_QUOTA' })
    // The live cut facts decide, whatever stage the keeper stored: there is no stored stage in the facts at all (R-61).
    expect(markDecision('URGENT', facts({ cut: { day: '2026-11-16', leather: true } }))).toEqual({ outcome: 'ASK', reason: 'CUT', words: askUsWords('CUT', 3) })
    expect(markDecision('URGENT', facts({ cut: { day: '2026-11-16', leather: false }, used: 0 }))).toMatchObject({ outcome: 'ASK', reason: 'CUT' })
    expect(Object.keys(facts())).not.toContain('stage')
    expect(askUsWords('OVER_QUOTA', 3).en).toBe('You have used your 3 urgent marks: ask us to make it urgent.')
  })

  it('back to Regular is always free (over the quota, after the cut); refused while we locked it; nothing changes twice', () => {
    expect(markDecision('REGULAR', facts({ row: urgent('so-1', 1), used: 5, cut: { day: '2026-11-16', leather: true } }))).toEqual({ outcome: 'AT_ONCE' })
    const locked = urgencyRow('so-1', { locked: true, lockReason: 'The fabric is already cut for another delivery.' })
    expect(markDecision('URGENT', facts({ row: locked }))).toEqual({ outcome: 'REFUSED', code: 'LOCKED', words: setBackWords('The fabric is already cut for another delivery.') })
    expect(setBackWords('The fabric is already cut for another delivery.').en).toBe('Set to Regular by us: The fabric is already cut for another delivery.')
    expect(markDecision('REGULAR', facts({ row: locked }))).toMatchObject({ outcome: 'REFUSED', code: 'UNCHANGED' })
    expect(markDecision('URGENT', facts({ row: urgent('so-1', 1) }))).toEqual({ outcome: 'REFUSED', code: 'UNCHANGED', words: unchangedWords('URGENT') })
  })

  it('refused in neutral words while the switch is off (both ways) and once the order left production', () => {
    expect(markDecision('URGENT', facts({ urgencyOn: false }))).toEqual({ outcome: 'REFUSED', code: 'URGENCY_OFF', words: URGENCY_NOT_OPEN_WORDS })
    expect(markDecision('REGULAR', facts({ urgencyOn: false, row: urgent('so-1', 1) }))).toMatchObject({ outcome: 'REFUSED', code: 'URGENCY_OFF' })
    expect(markDecision('URGENT', facts({ row: urgencyRow('so-1', { open: false }) }))).toEqual({ outcome: 'REFUSED', code: 'NOT_OPEN', words: NOT_IN_PRODUCTION_WORDS })
  })
})

describe("B-PR-41 the customer's Urgent list: move to top, the whole list", () => {
  const rows = [urgent('u1', 1), urgent('u2', 2), urgent('u3', 3), urgencyRow('r1')]

  it('"Move to top" puts an urgent order first; on a Regular order it says "Mark urgent first" (R-65)', () => {
    expect(moveToTop(rows, { partyId: A, orderId: 'u3' })).toEqual({ orderIds: ['u3', 'u1', 'u2'] })
    expect(moveToTop(rows, { partyId: A, orderId: 'r1' })).toEqual({ refused: MARK_URGENT_FIRST_WORDS })
    expect(moveToTop(rows, { partyId: A, orderId: 'unknown' })).toEqual({ refused: NOT_IN_PRODUCTION_WORDS })
  })

  it('the new order names every urgent order once; a Regular one says "Mark urgent first"; an unknown id is only "not found"', () => {
    expect(urgentOrderProblems(rows, { partyId: A, urgencyOn: true, orderIds: ['u2', 'u3', 'u1'] })).toEqual([])
    expect(urgentOrderProblems(rows, { partyId: A, urgencyOn: true, orderIds: ['u2', 'u3', 'u1', 'r1'] })).toEqual([{ path: 'body/orderIds/3', message: 'Mark urgent first' }])
    expect(urgentOrderProblems(rows, { partyId: A, urgencyOn: true, orderIds: ['u2', 'u3', 'u1', 'so-of-someone'] })).toEqual([{ path: 'body/orderIds/3', message: 'Order not found.' }])
    expect(urgentOrderProblems(rows, { partyId: A, urgencyOn: true, orderIds: ['u2', 'u2', 'u1', 'u3'] })).toEqual([{ path: 'body/orderIds/1', message: 'This order is named twice.' }])
    expect(urgentOrderProblems(rows, { partyId: A, urgencyOn: true, orderIds: ['u2', 'u1'] })).toEqual([{ path: 'body/orderIds', message: 'Name every urgent order, in the order you want them.' }])
    expect(urgentOrderProblems(rows, { partyId: A, urgencyOn: false, orderIds: ['u1', 'u2', 'u3'] })).toEqual([{ path: 'body/orderIds', message: URGENCY_NOT_OPEN_WORDS.en }])
  })
})

describe('B-PR-41 undo of an urgency batch', () => {
  const batch = 'batch-1'
  const base = { partyId: A, urgencyOn: true, max: 3, cuts: new Map() }

  it('puts each row back; a row changed since is left as it is; going back to Urgent passes the mark\'s rules; Regular is free', () => {
    const entries = [
      { row: urgencyRow('r-was-urgent'), batchIdNow: batch, before: { urgency: 'URGENT' as const, urgentRank: 1 } },
      { row: urgencyRow('r-changed-since'), batchIdNow: 'batch-2', before: { urgency: 'URGENT' as const, urgentRank: 2 } },
      { row: urgencyRow('r-locked', { locked: true, lockReason: 'Our plan.' }), batchIdNow: batch, before: { urgency: 'URGENT' as const, urgentRank: 3 } },
      { row: urgent('u-was-regular', 4), batchIdNow: batch, before: { urgency: 'REGULAR' as const, urgentRank: null } },
    ]
    expect(undoPlan(batch, entries, { ...base, used: 2 })).toEqual({
      restore: [
        { orderId: 'r-was-urgent', urgency: 'URGENT', urgentRank: 1 },
        { orderId: 'u-was-regular', urgency: 'REGULAR', urgentRank: null },
      ],
      skipped: [
        { orderId: 'r-changed-since', words: CHANGED_SINCE_WORDS },
        { orderId: 'r-locked', words: setBackWords('Our plan.') },
      ],
    })
  })

  it('never makes an urgent mark the customer could not: over the quota or after a cut (live) it is skipped with the ask words', () => {
    const entries = [{ row: urgencyRow('r1'), batchIdNow: batch, before: { urgency: 'URGENT' as const, urgentRank: 1 } }]
    expect(undoPlan(batch, entries, { ...base, used: 3 }).skipped).toEqual([{ orderId: 'r1', words: askUsWords('OVER_QUOTA', 3) }])
    expect(undoPlan(batch, entries, { ...base, used: 0, cuts: new Map([['r1', { day: '2026-11-16', leather: false }]]) }).skipped).toEqual([{ orderId: 'r1', words: askUsWords('CUT', 3) }])
    expect(() => undoPlan(batch, [{ row: urgencyRow('b1', { partyId: B }), batchIdNow: batch, before: { urgency: 'URGENT', urgentRank: 1 } }], { ...base, used: 0 })).toThrow(/another customer/)
  })
})

describe('B-PR-41 the production supervisor', () => {
  const grant = (permissions: readonly string[], parties: Grant['parties'] = 'all', companies: Grant['companies'] = 'all'): Grant => ({ permissions: permissions as Permission[], companies, sites: 'all', parties })
  const office = (...grants: Grant[]): Actor => ({ audience: 'office', tenantId: 'tenant-1', grants })
  const person = (actor: Actor, over: Partial<SupervisorCandidate> = {}): SupervisorCandidate => ({ audience: 'OFFICE', status: 'ACTIVE', actor, ...over })
  const scope = { companyId: 'company-1', partyId: A }

  it("an order's own supervisor, else the customer's default; a work order's is its single order's, else the customer's default", () => {
    expect(effectiveSupervisor('user-own', 'user-default')).toEqual({ userId: 'user-own', from: 'ORDER' })
    expect(effectiveSupervisor(null, 'user-default')).toEqual({ userId: 'user-default', from: 'BRAND' })
    expect(effectiveSupervisor(null, null)).toEqual({ userId: null, from: null })
    expect(workOrderSupervisor({ orders: [{ salesOrderId: 'so-1', supervisorId: 'user-own' }, { salesOrderId: 'so-1', supervisorId: 'user-own' }], customerDefault: 'user-default' })).toEqual({ userId: 'user-own', from: 'ORDER' })
    expect(workOrderSupervisor({ orders: [{ salesOrderId: 'so-1', supervisorId: null }], customerDefault: 'user-default' })).toEqual({ userId: 'user-default', from: 'BRAND' })
    expect(workOrderSupervisor({ orders: [{ salesOrderId: 'so-1', supervisorId: 'user-own' }, { salesOrderId: 'so-2', supervisorId: 'user-other' }], customerDefault: 'user-default' })).toEqual({ userId: 'user-default', from: 'BRAND' })
    expect(workOrderSupervisor({ orders: [], customerDefault: null })).toEqual({ userId: null, from: null })
  })

  it('lists say Me / Someone else / Not set, never a name', () => {
    expect(supervisorMarkOf({ userId: 'me', from: 'ORDER' }, 'me')).toBe('ME')
    expect(supervisorMarkOf({ userId: 'other', from: 'BRAND' }, 'me')).toBe('SOMEONE_ELSE')
    expect(supervisorMarkOf({ userId: null, from: null }, 'me')).toBe('NOT_SET')
    expect(SUPERVISOR_MARK_WORDS.SOMEONE_ELSE).toEqual({ it: 'Qualcun altro', en: 'Someone else' })
  })

  it('eligible: an active office person with production.brand.manage or workorders.view over the company and the customer, and the measurements right', () => {
    expect(supervisorRefusals(person(office(grant(['production.brand.manage', 'sales.measurements.view']))), scope)).toEqual([])
    expect(supervisorRefusals(person(office(grant(['workorders.view', 'sales.measurements.view']))), scope)).toEqual([])
    expect(supervisorRefusals(person(office(grant(['workorders.view']))), scope)).toEqual(['NO_MEASUREMENTS'])
    expect(supervisorRefusals(person(office(grant(['sales.measurements.view']))), scope)).toEqual(['NO_REACH'])
    expect(supervisorRefusals(person(office(grant(['workorders.view', 'sales.measurements.view'])), { status: 'SUSPENDED' }), scope)).toEqual(['NOT_ACTIVE'])
    expect(supervisorRefusals(person({ audience: 'partner', tenantId: 'tenant-1', partyId: A, grants: [grant(['workorders.view', 'sales.measurements.view'])] }, { audience: 'PARTNER' }), scope)).toEqual(['NOT_OFFICE'])
    expect(supervisorRefusals(person(office(grant(['workorders.view', 'sales.measurements.view'], 'all', ['company-2']))), scope)).toEqual(['NO_REACH', 'NO_MEASUREMENTS'])
    expect(supervisorProblems(person(office(grant(['workorders.view']))), scope)).toEqual([{ path: 'body/supervisorId', message: SUPERVISOR_REFUSAL_WORDS.NO_MEASUREMENTS.en }])
  })

  it('wall (PW-14 pure): a person whose grant does not reach the customer is not eligible, even holding every permission for another one', () => {
    const limitedToB = person(office(grant(['production.brand.manage', 'workorders.view', 'sales.measurements.view'], [B])))
    expect(supervisorRefusals(limitedToB, scope)).toEqual(['NO_REACH', 'NO_MEASUREMENTS'])
    expect(supervisorRefusals(limitedToB, { companyId: 'company-1', partyId: B })).toEqual([])
    // The measurements right over the other customer only does not count for this one.
    expect(supervisorRefusals(person(office(grant(['workorders.view']), grant(['sales.measurements.view'], [B]))), scope)).toEqual(['NO_MEASUREMENTS'])
  })

  it('a backup only beside a supervisor and never the same person', () => {
    expect(backupProblems({ supervisorId: 'u1', backupId: 'u2' })).toEqual([])
    expect(backupProblems({ supervisorId: 'u1', backupId: null })).toEqual([])
    expect(backupProblems({ supervisorId: null, backupId: 'u2' })[0]?.message).toMatch(/beside a supervisor/)
    expect(backupProblems({ supervisorId: 'u1', backupId: 'u1' })[0]?.message).toMatch(/another person/)
  })
})

describe('B-PR-41 the escalation clock: due raise + 1 working day → backup, raise + 2 → Owner and Admin, 08:00 company time (R-44)', () => {
  const window = { from: '2026-11-01', to: '2026-12-31' }
  const plain = workingCalendar({ layers: [], patterns: new Map(), timeZone: 'Europe/Rome', window })
  const holiday: CalendarLayer = {
    id: 'calendar-1',
    scope: 'COMPANY',
    name: 'Company A (made up)',
    workingWeekdays: [1, 2, 3, 4, 5],
    shiftPatternId: null,
    days: new Map([['2026-11-19', { date: '2026-11-19', kind: 'HOLIDAY' as const, name: 'Made-up holiday', shiftPatternId: null }]]),
  }
  const withHoliday = workingCalendar({ layers: [holiday], patterns: new Map(), timeZone: 'Europe/Rome', window })
  const clockOf = (calendar: typeof plain, raisedAt: string): EscalationClock => {
    const clock = escalationClock(calendar, new Date(raisedAt))
    if ('beyond' in clock) throw new Error('the window ran out')
    return clock
  }

  it('raised on a Tuesday: due Wednesday, the backup at 08:00 Wednesday, the Owner and Admin at 08:00 Thursday (Rome time)', () => {
    expect(clockOf(plain, '2026-11-17T10:00:00Z')).toEqual({ dueOn: '2026-11-18', backupAt: new Date('2026-11-18T07:00:00.000Z'), ownerAt: new Date('2026-11-19T07:00:00.000Z') })
  })

  it('counts working days of the company calendar: a weekend and a holiday are skipped; the raise day is the company\'s day', () => {
    expect(clockOf(plain, '2026-11-20T15:00:00Z')).toEqual({ dueOn: '2026-11-23', backupAt: new Date('2026-11-23T07:00:00.000Z'), ownerAt: new Date('2026-11-24T07:00:00.000Z') })
    expect(clockOf(withHoliday, '2026-11-17T10:00:00Z')).toEqual({ dueOn: '2026-11-18', backupAt: new Date('2026-11-18T07:00:00.000Z'), ownerAt: new Date('2026-11-20T07:00:00.000Z') })
    // 00:30 on Wednesday in Rome is still Tuesday in UTC: the company's day counts.
    expect(clockOf(plain, '2026-11-17T23:30:00Z').dueOn).toBe('2026-11-19')
    expect(escalationClock(workingCalendar({ layers: [], patterns: new Map(), timeZone: 'Europe/Rome', window: { from: '2026-11-01', to: '2026-11-18' } }), new Date('2026-11-17T10:00:00Z'))).toEqual({ beyond: '2026-11-18' })
  })

  it('the step reached by now, and the steps still to take (each once)', () => {
    const clock = clockOf(plain, '2026-11-17T10:00:00Z')
    expect(escalationStepAt(clock, new Date('2026-11-18T06:59:59Z'))).toBe(0)
    expect(escalationStepAt(clock, new Date('2026-11-18T07:00:00Z'))).toBe(1)
    expect(escalationStepAt(clock, new Date('2026-11-19T07:00:00Z'))).toBe(2)
    expect(escalationStepsDue(clock, 0, new Date('2026-11-19T08:00:00Z'))).toEqual([1, 2])
    expect(escalationStepsDue(clock, 1, new Date('2026-11-19T08:00:00Z'))).toEqual([2])
    expect(escalationStepsDue(clock, 2, new Date('2026-11-25T08:00:00Z'))).toEqual([])
    expect(escalationStepsDue(clock, 0, new Date('2026-11-17T12:00:00Z'))).toEqual([])
  })
})

describe('B-PR-41 the words of urgency, the supervisor and the limits card', () => {
  const brandWords = [
    ...Object.values(URGENCY_WORDS),
    urgentUsedWords({ used: 2, max: 3, agreed: 0 }),
    urgentUsedWords({ used: 4, max: 3, agreed: 1 }),
    CHANGED_BY_US_WORDS,
    setBackWords(null),
    MARK_URGENT_FIRST_WORDS,
    ASK_US_WORDS,
    askUsWords('CUT', 3),
    askUsWords('OVER_QUOTA', 3),
    askUsWords('OVER_QUOTA', 1),
    askUsWords('OVER_QUOTA', 0),
    URGENCY_NOT_OPEN_WORDS,
    NOT_IN_PRODUCTION_WORDS,
    unchangedWords('URGENT'),
    unchangedWords('REGULAR'),
    CHANGED_SINCE_WORDS,
  ]
  const officeWords = [
    CUSTOMER_URGENCY_WORDS.header,
    CUSTOMER_URGENCY_WORDS.chip,
    ...Object.values(SUPERVISOR_WORDS),
    ...Object.values(SUPERVISOR_MARK_WORDS),
    ...Object.values(SUPERVISOR_REFUSAL_WORDS),
    ESCALATION_WORDS,
    dormantMarksWords(1)!,
    dormantMarksWords(3)!,
    overQuotaWords(4, 3)!,
    PRODUCTION_ROLE_NOT_OFFERED_WORDS,
  ]

  it('every word in Italian and English; the picks of 17-web-r2 §5', () => {
    for (const words of [...brandWords, ...officeWords]) {
      expect(words.it.trim()).not.toBe('')
      expect(words.en.trim()).not.toBe('')
    }
    expect(URGENCY_WORDS).toEqual({ URGENT: { it: 'Urgente', en: 'Urgent' }, REGULAR: { it: 'Normale', en: 'Regular' } })
    expect(CUSTOMER_URGENCY_WORDS).toEqual({ header: { it: 'Urgenza cliente', en: 'Customer urgency' }, chip: { it: 'Urgente (cliente)', en: 'Urgent (customer)' } })
    expect(SUPERVISOR_WORDS.title.it).toBe('Supervisore di produzione')
    expect(dormantMarksWords(3)!.en).toBe('3 urgent marks are kept but not used while this is off.')
    expect(dormantMarksWords(0)).toBeNull()
    expect(overQuotaWords(2, 3)).toBeNull()
  })

  it('wall: the words a customer reads name no place, no other customer, no supervisor, no person, and take no name', () => {
    const forbidden = /supplier|workshop|worker|operator|station|production line|another customer|other customer|supervis|position|place in|queue|fornitor|laborator|operai|postazion|linea di produzione|altro cliente|altri clienti|supervisor|posizione|coda|\{/i
    for (const words of brandWords) {
      expect(words.en, words.en).not.toMatch(forbidden)
      expect(words.it, words.it).not.toMatch(forbidden)
    }
  })
})

// ── B-PR-22a ──
describe('B-PR-22a the Urgent list put back and the portal command words', () => {
  it('places undone orders back at their old places, from the first place down, clamped to the end; the rest keep their order', () => {
    expect(placeInUrgentList(['c', 'a', 'b'], [{ orderId: 'a', rank: 1 }, { orderId: 'b', rank: 2 }])).toEqual(['a', 'b', 'c'])
    expect(placeInUrgentList(['b', 'a', 'c'], [{ orderId: 'a', rank: 1 }, { orderId: 'b', rank: 2 }])).toEqual(['a', 'b', 'c'])
    expect(placeInUrgentList(['a', 'c'], [{ orderId: 'b', rank: 2 }])).toEqual(['a', 'b', 'c'])
    expect(placeInUrgentList(['a'], [{ orderId: 'b', rank: 9 }])).toEqual(['a', 'b'])
    expect(placeInUrgentList([], [])).toEqual([])
    expect([...ranksOf(['x', 'y', 'z'])]).toEqual([
      ['x', 1],
      ['y', 2],
      ['z', 3],
    ])
  })

  it('every outcome is a known code; the refusal words name no person, place, line or other customer', () => {
    expect(URGENCY_OUTCOMES).toEqual(expect.arrayContaining(['DONE', 'ASK_CUT', 'ASK_OVER_QUOTA', 'URGENCY_OFF', 'NOT_OPEN', 'LOCKED', 'UNCHANGED', 'NOT_KEPT']))
    const forbidden = /supervisor|line \d|work order|worker|other customer|another customer|position|queue/i
    for (const words of [ORDER_NOT_FOUND_WORDS, NOT_KEPT_YET_WORDS, changedAtWords('10:42'), changedByUsAtWords('10:42'), URGENT_ORDER_UNCHANGED_WORDS, NOTHING_TO_UNDO_WORDS, NOTHING_UNDONE_WORDS]) {
      expect(words.en.length).toBeGreaterThan(0)
      expect(words.it.length).toBeGreaterThan(0)
      expect(words.en, words.en).not.toMatch(forbidden)
    }
    expect(changedAtWords('10:42')).toEqual({ it: "Cambiato alle 10:42: rileggete l'elenco.", en: 'Changed at 10:42: read the list again.' })
    // F-PR-11: our change says when, never who ("Changed by us at 10:42").
    expect(changedByUsAtWords('10:42')).toEqual({ it: "Modificato da noi alle 10:42: rileggete l'elenco.", en: 'Changed by us at 10:42: read the list again.' })
  })
})

// ── B-PR-22b ──
describe("B-PR-22b the factory's set-back reason and the board's chip", () => {
  it('a reason is one line of 1 to 500 characters (the customer reads it while locked)', () => {
    expect(lockReasonProblems('Made-up: the deposit is not paid yet.')).toEqual([])
    expect(lockReasonProblems('')).toEqual([{ path: 'body/reason', message: 'Give the reason the customer reads.' }])
    expect(lockReasonProblems(undefined)).toHaveLength(1)
    expect(lockReasonProblems('one\ntwo')).toEqual([{ path: 'body/reason', message: 'The reason is one line.' }])
    expect(lockReasonProblems('x'.repeat(URGENCY_LOCK_REASON_MAX))).toEqual([])
    expect(lockReasonProblems('x'.repeat(URGENCY_LOCK_REASON_MAX + 1))).toHaveLength(1)
    expect(URGENCY_OFFICE_BATCH_MAX).toBe(100)
  })

  it('the chip names the place in the customer\'s own list only, in both languages; the office words name no person', () => {
    expect(customerUrgencyChipWords(2)).toEqual({ it: 'Urgenza cliente: Urgente 2', en: 'Customer urgency: Urgent 2' })
    expect(customerUrgencyChipWords(null)).toEqual({ it: 'Urgenza cliente: Urgente', en: 'Customer urgency: Urgent' })
    for (const words of [ALREADY_LOCKED_WORDS, NOT_LOCKED_WORDS, NO_OVERRIDE_RIGHT_WORDS]) {
      expect(words.en.length).toBeGreaterThan(0)
      expect(words.it.length).toBeGreaterThan(0)
    }
  })
})
