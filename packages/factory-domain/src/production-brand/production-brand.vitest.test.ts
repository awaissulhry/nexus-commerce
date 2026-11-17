import { describe, expect, it } from 'vitest'
import { FACTORY_PERMISSIONS } from '../auth/permissions/catalogue'
import { PARTNER_ROLE_TEMPLATES, partnerTemplateOf, ROLE_TEMPLATES, templateOf } from '../auth/roles/templates'
import { PROMISE_REASON_CODES } from '../sales/portal-orders/promise'
import { groupOf, maySee, PORTAL_DOCUMENT_KINDS, type DocumentAccess } from '../sales/portal-documents/library'
import { PORTAL_CUSTOMER_DOCUMENTS_CONFORMITY, PORTAL_CUSTOMER_DOCUMENTS_FINANCE, PORTAL_CUSTOMER_DOCUMENTS_VIEW } from '../sales/portal-documents/permissions'
import { freezeVerdict, rulesForParty, type FreezeRuleFacts } from '../sales/order-changes/freeze'
import { computedHealth, effectiveHealth, HEALTH_REASON_CODES, raiseProblems, raiseStands, raiseUntil, type BrandHealth } from './health'
import { askKindsProblems, isAskOpen, openAskKinds, PRODUCTION_REQUEST_KINDS } from './kinds'
import { maskByLevel, maskOf, PRODUCTION_SHARE_LEVELS, progressSharedOf, qualityResultsShown, shares } from './levels'
import { CUSTOMER_PRODUCTION_ROLE } from './permissions'
import { BRAND_STAGES, lineStageOf, movedForward, orderStageOf, type LineStageFacts } from './stages'
import { BLOCKER_KINDS, BLOCKER_OWNER, brandSideOf, waitingOn, WAITING_ON } from './waiting'
import { aheadWords, ASK_KIND_WORDS, ASK_NOT_OPEN_WORDS, BRAND_WAITING_WORDS, HEALTH_REASON_WORDS, HEALTH_WORDS, LEVEL_WORDS, OFFICE_WAITING_WORDS, SEWING_NOT_COUNTED_WORDS, STAGE_WORDS } from './words'

const line = (facts: Partial<LineStageFacts> = {}): LineStageFacts => ({ reached: null, allReleased: false, done: false, sewingCounted: true, ...facts })

describe('B-PR-13 share levels and their masks', () => {
  it('STATUS masks progress, gates and quality; each level adds to the one before (wall: a section not shared is not drawn)', () => {
    expect(maskOf('STATUS')).toEqual({ progress: false, gates: false, quality: false })
    expect(maskOf('PROGRESS')).toEqual({ progress: true, gates: false, quality: false })
    expect(maskOf('GATES')).toEqual({ progress: true, gates: true, quality: false })
    expect(maskOf('QUALITY')).toEqual({ progress: true, gates: true, quality: true })
    for (const level of PRODUCTION_SHARE_LEVELS) expect(progressSharedOf(level)).toBe(shares(level, 'progress'))
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

  it('the Production role: its orders and their production, urgency, approvals, samples, shared files and messages; no price grain, no ask yet', () => {
    const production = role(CUSTOMER_PRODUCTION_ROLE)
    expect(production).toMatchObject({ kind: 'CUSTOMER', admin: false, name: 'Production', grains: [] })
    for (const permission of ['portal.home.view', 'portal.search', 'portal.salesOrders.view', 'portal.approvals.view', 'portal.samples.view', 'portal.customerDocuments.view', 'portal.comment', 'portal.production.view', 'portal.production.urgency']) {
      expect(has(CUSTOMER_PRODUCTION_ROLE, permission), permission).toBe(true)
    }
    for (const permission of ['portal.customerDocuments.finance', 'portal.customerDocuments.conformity', 'portal.salesOrders.ask', 'portal.orderRequests.manage', 'portal.payments.view', 'portal.colleagues.manage']) {
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
