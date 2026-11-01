import { describe, expect, it } from 'vitest'
import { heldGrains, GRAINS } from '../../auth/grains/grains'
import { FLOOR_GRAINS } from '../../auth/floor/grants'
import { ROLE_TEMPLATES, templateOf } from '../../auth/roles/templates'
import { FACTORY_PERMISSIONS } from '../../auth/permissions/catalogue'
import { grainOfSchema, money } from '../../money/marked'
import { z } from 'zod'
import { PEOPLE_PIECERATES_PERMISSIONS } from './permissions'
import {
  confirmRefusal,
  inForceOn,
  inForcePlan,
  ratePerPieceOf,
  ratesOf,
  readByOf,
  termsProblems,
  trialTiles,
  versionStateOf,
  type VersionRow,
} from './rates'
import { preconditionsOf, startProblems, stopDayOf, windowsAfterRestart, type SwitchFacts } from './switch'

/**
 * Piece rates and the legal switch (B-W2b-34; MES-254, MES-255, MES-262; c.c. arts. 2100-2101 — rates communicated to the
 * workers before they apply, changed only by a new version; Statuto dei Lavoratori art. 4 c.1, c.3; GDPR arts. 13, 35).
 * Made-up figures only.
 */

const version = (over: Partial<VersionRow> = {}): VersionRow => ({ id: 'v1', versionNo: 1, status: 'DRAFT', effectiveFrom: '2026-11-13', effectiveTo: null, provisional: false, trialEndsOn: null, ...over })

describe('rates (MES-254)', () => {
  it('makes SMV × rate per minute, rounded half up to six decimals (the guard rounds the same way)', () => {
    expect(ratePerPieceOf('96.5', '0.12')).toBe('11.58')
    expect(ratePerPieceOf('1.333', '0.0000015')).toBe('0.000002')
    expect(ratePerPieceOf('0.001', '0.0000005')).toBe('0')
  })

  it('checks each rate at its place and fills the rate per piece', () => {
    const op = '11111111-1111-4111-8111-111111111111'
    const ok = ratesOf([
      { operationId: op, basis: 'SMV_RATE', standardMinutes: '96.5', ratePerMinute: '0.12' },
      { operationId: op, sizeBand: 'xl-3xl', basis: 'FIXED', ratePerPiece: '0.30' },
    ])
    expect(ok.problems).toEqual([])
    expect(ok.rates).toEqual([
      { operationId: op, sizeBand: 'ALL', basis: 'SMV_RATE', standardMinutes: '96.5', ratePerMinute: '0.12', ratePerPiece: '11.58', note: null },
      { operationId: op, sizeBand: 'XL-3XL', basis: 'FIXED', standardMinutes: null, ratePerMinute: null, ratePerPiece: '0.3', note: null },
    ])
    const bad = ratesOf([
      { operationId: op, basis: 'SMV_RATE', standardMinutes: '0', ratePerMinute: '0.12' },
      { operationId: op, basis: 'SMV_RATE', standardMinutes: '10', ratePerMinute: '0.1', ratePerPiece: '9.99' },
      { operationId: op, basis: 'FIXED', ratePerMinute: '0.1', ratePerPiece: '-1' },
    ])
    expect(bad.rates).toEqual([])
    expect(bad.problems.map((problem) => problem.path)).toEqual(['rates/0/standardMinutes', 'rates/1/operationId', 'rates/1/ratePerPiece', 'rates/2/operationId', 'rates/2/ratePerMinute', 'rates/2/ratePerPiece'])
    expect(bad.problems[2]!.message).toContain('makes 1 a piece')
  })

  it('asks why a version changes, and a trial end exactly for a provisional rate (MES-262)', () => {
    expect(termsProblems({ changeReason: 'NEW', effectiveFrom: '2026-11-13' })).toEqual([])
    expect(termsProblems({ changeReason: 'CORRECTION', effectiveFrom: '2026-11-13' }).map((problem) => problem.path)).toEqual(['changeNote'])
    expect(termsProblems({ changeReason: 'NEW', effectiveFrom: '2026-11-13', provisional: true }).map((problem) => problem.path)).toEqual(['trialEndsOn'])
    expect(termsProblems({ changeReason: 'NEW', effectiveFrom: '2026-11-13', provisional: true, trialEndsOn: '2026-11-13' })[0]!.message).toContain('after the first day')
    expect(termsProblems({ changeReason: 'NEW', effectiveFrom: '2026-11-13', provisional: true, trialEndsOn: '2028-01-01' })[0]!.message).toContain('at most 366 days')
    expect(termsProblems({ changeReason: 'NEW', effectiveFrom: '2026-11-13', trialEndsOn: '2026-12-31' })[0]!.path).toBe('trialEndsOn')
  })
})

describe('putting a version in force (c.c. art. 2101 c.3: told before it applies)', () => {
  const base = { today: '2026-11-01', rateCount: 2, tableActive: true, publishedOn: ['2026-11-01'], others: [] as VersionRow[] }

  it('refuses before a publication dated on or before the first day, and a first day in the past', () => {
    expect(inForcePlan({ ...base, version: version(), publishedOn: [] }).refusal?.code).toBe('NOT_PUBLISHED')
    expect(inForcePlan({ ...base, version: version(), publishedOn: ['2026-11-14'] }).refusal?.code).toBe('NOT_PUBLISHED')
    expect(inForcePlan({ ...base, version: version({ effectiveFrom: '2026-10-31' }) }).refusal?.code).toBe('STARTS_IN_PAST')
    expect(inForcePlan({ ...base, version: version(), rateCount: 0 }).refusal?.code).toBe('NO_RATES')
    expect(inForcePlan({ ...base, version: version(), tableActive: false }).refusal?.code).toBe('TABLE_ARCHIVED')
    expect(inForcePlan({ ...base, version: version({ status: 'PUBLISHED' }) }).refusal?.code).toBe('NOT_DRAFT')
  })

  it('supersedes the open version before it (its last day the day before) and refuses one that starts later', () => {
    const v1 = version({ id: 'a', versionNo: 1, status: 'PUBLISHED', effectiveFrom: '2026-11-13' })
    const v2 = version({ id: 'b', versionNo: 2, effectiveFrom: '2027-01-01', provisional: true, trialEndsOn: '2027-02-28' })
    const { plan } = inForcePlan({ ...base, version: v2, others: [v1] })
    expect(plan).toEqual({ status: 'PROVISIONAL', supersedes: [{ id: 'a', versionNo: 1, effectiveTo: '2026-12-31' }] })
    expect(inForcePlan({ ...base, version: version({ id: 'c', versionNo: 3, effectiveFrom: '2026-11-13' }), others: [v1] }).refusal?.code).toBe('STARTS_BEFORE_LATEST')
    const closed = version({ id: 'd', versionNo: 1, status: 'SUPERSEDED', effectiveFrom: '2026-11-02', effectiveTo: '2026-11-20' })
    expect(inForcePlan({ ...base, version: version({ id: 'e', versionNo: 2, effectiveFrom: '2026-11-10' }), others: [closed] }).refusal?.code).toBe('OVERLAPS')
    expect(inForcePlan({ ...base, version: version({ id: 'f', versionNo: 2, effectiveFrom: '2026-11-21' }), others: [closed] }).plan?.supersedes).toEqual([])
  })

  it('says the status in the rate table\'s words and pays only on its days', () => {
    expect(versionStateOf(version({ status: 'PROVISIONAL', provisional: true, trialEndsOn: '2027-02-28' }), '2026-12-01')).toEqual({ state: 'PROVISIONAL', words: 'Provisional until 2027-02-28.' })
    expect(versionStateOf(version({ status: 'PUBLISHED', provisional: true, trialEndsOn: '2027-02-28' }), '2027-03-01').words).toBe('Confirmed after its trial.')
    expect(versionStateOf(version({ status: 'SUPERSEDED', effectiveTo: '2026-12-31' }), '2026-12-01').words).toContain('Pays until 2026-12-31')
    expect(inForceOn(version({ status: 'SUPERSEDED', effectiveTo: '2026-12-31' }), '2026-12-31')).toBe(true)
    expect(inForceOn(version({ status: 'SUPERSEDED', effectiveTo: '2026-12-31' }), '2027-01-01')).toBe(false)
    expect(inForceOn(version({ status: 'DRAFT' }), '2026-12-01')).toBe(false)
  })

  it('confirms a provisional rate from the last day of its trial (MES-262)', () => {
    const provisional = version({ status: 'PROVISIONAL', provisional: true, trialEndsOn: '2027-02-28' })
    expect(confirmRefusal(provisional, '2027-02-27')?.code).toBe('TRIAL_RUNNING')
    expect(confirmRefusal(provisional, '2027-02-28')).toBeNull()
    expect(confirmRefusal(version({ status: 'PUBLISHED' }), '2027-03-01')?.code).toBe('NOT_PROVISIONAL')
    expect(trialTiles([provisional, version({ status: 'PROVISIONAL', provisional: true, trialEndsOn: '2026-11-01' })], '2027-02-20')).toEqual({ endingSoon: 1, ended: 1 })
  })

  it('counts "read by n of m" over the distinct workers of live publications only', () => {
    const publications = [
      { id: 'p1', status: 'PUBLISHED', workerIds: ['w1', 'w2'] },
      { id: 'p2', status: 'PUBLISHED', workerIds: ['w2', 'w3'] },
      { id: 'p3', status: 'WITHDRAWN', workerIds: ['w4'] },
    ]
    const receipts = [
      { publicationId: 'p1', workerId: 'w2' },
      { publicationId: 'p2', workerId: 'w2' },
      { publicationId: 'p3', workerId: 'w4' },
    ]
    expect(readByOf(publications, receipts)).toEqual({ read: 1, of: 3 })
  })
})

const facts = (over: Partial<SwitchFacts> = {}): SwitchFacts => ({
  today: '2026-11-01',
  onFrom: '2026-11-13',
  scanSubject: 'WORKER',
  siteBasis: { kind: 'UNION_AGREEMENT', reference: 'RSU agreement (made up)' },
  performanceGateOpen: true,
  ccnlName: 'A made-up CCNL',
  ccnlArticle: 'art. 0',
  workerNotice: { id: 'n', label: '2026-10', kind: 'WORKER_FLOOR', status: 'PUBLISHED' },
  dpia: { id: 'd', versionNo: 1, status: 'STORED' },
  consultantName: 'A made-up consultant',
  consultantAgreedOn: '2026-10-30',
  scheme: { id: 's', name: 'Piece rate', status: 'ACTIVE', siteId: null, validFrom: '2026-11-01', validTo: null },
  siteId: 'site',
  ratesInForce: 1,
  activeWorkers: 2,
  workersNotTold: 0,
  earningCodes: 2,
  unmappedEarningCodes: [],
  ...over,
})

describe('the legal switch (GATE-PIECE-PAY; Statuto art. 4 c.1, c.3; GDPR arts. 13, 35; c.c. arts. 2100-2101)', () => {
  it('lists every precondition with its law, met when all is on record', () => {
    const items = preconditionsOf(facts())
    expect(items.map((item) => item.code)).toEqual(['SITE_BASIS', 'PERFORMANCE_GATE', 'WORKER_NOTICE', 'DPIA', 'CCNL', 'CONSULTANT', 'SCHEME', 'RATES_PUBLISHED', 'EARNING_CODES'])
    expect(items.every((item) => item.met)).toBe(true)
    expect(items.find((item) => item.code === 'CCNL')!.law).toBe('c.c. art. 2100')
    expect(items.find((item) => item.code === 'RATES_PUBLISHED')!.law).toBe('c.c. art. 2101')
  })

  it('holds the switch with each missing item in words, never a greyed button', () => {
    const missing = preconditionsOf(
      facts({ scanSubject: 'STATION', performanceGateOpen: false, workerNotice: null, dpia: null, ccnlArticle: null, consultantAgreedOn: '2026-11-02', scheme: null, workersNotTold: 1, unmappedEarningCodes: ['MAKE_UP'] }),
    ).filter((item) => !item.met)
    expect(missing.map((item) => item.code)).toEqual(['SITE_BASIS', 'PERFORMANCE_GATE', 'WORKER_NOTICE', 'DPIA', 'CCNL', 'CONSULTANT', 'SCHEME', 'RATES_PUBLISHED', 'EARNING_CODES'])
    expect(missing.find((item) => item.code === 'RATES_PUBLISHED')!.words).toContain('1 of 2 active workers have not been given the rates')
    expect(missing.find((item) => item.code === 'EARNING_CODES')!.words).toContain('MAKE_UP')
    expect(preconditionsOf(facts({ scheme: { id: 's', name: 'Later', status: 'ACTIVE', siteId: null, validFrom: '2026-12-01', validTo: null } })).find((item) => item.code === 'SCHEME')!.met).toBe(false)
  })

  it('starts only from a day to come, after the last window, with a reason', () => {
    const off = { state: 'OFF' as const, onFrom: null, offFrom: null }
    expect(startProblems({ facts: facts(), window: off, reason: 'Agreed with the RSU' })).toEqual([])
    expect(startProblems({ facts: facts({ onFrom: '2026-10-31' }), window: off, reason: 'ok ok' })[0]!.path).toBe('onFrom')
    expect(startProblems({ facts: facts(), window: { state: 'OFF', onFrom: '2026-11-01', offFrom: '2026-11-20' }, reason: 'ok ok' })[0]!.message).toContain('2026-11-20')
    expect(startProblems({ facts: facts(), window: off, reason: '' }).map((problem) => problem.path)).toEqual(['reason'])
    expect(startProblems({ facts: facts({ dpia: null }), window: off, reason: 'ok ok' }).map((problem) => problem.path)).toEqual(['preconditions/DPIA'])
    // c.c. art. 2101: every active worker told the rates in force on the first day before piece pay starts.
    expect(startProblems({ facts: facts({ workersNotTold: 1 }), window: off, reason: 'ok ok' }).map((problem) => problem.path)).toEqual(['preconditions/RATES_PUBLISHED'])
    expect(startProblems({ facts: facts(), window: { state: 'ON', onFrom: '2026-11-13', offFrom: null }, reason: 'ok ok' })[0]!.path).toBe('state')
  })

  it('stops from today, or from its first day while that is to come; keeps the earlier windows', () => {
    expect(stopDayOf('2026-11-13', '2026-11-01')).toBe('2026-11-13')
    expect(stopDayOf('2026-11-13', '2026-11-20')).toBe('2026-11-20')
    expect(windowsAfterRestart([{ from: '2026-01-01', to: '2026-02-01' }], { state: 'OFF', onFrom: '2026-11-13', offFrom: '2026-11-20' })).toEqual([
      { from: '2026-01-01', to: '2026-02-01' },
      { from: '2026-11-13', to: '2026-11-20' },
    ])
    expect(windowsAfterRestart([], { state: 'OFF', onFrom: null, offFrom: null })).toEqual([])
  })
})

describe('the pay grain (W2b plan §6, §11: HR and the worker only)', () => {
  it('is a grain of its own that only the owner of the office templates holds; the floor sees a worker\'s own', () => {
    expect(GRAINS).toContain('pay')
    expect(grainOfSchema(money.pay(z.string()))).toBe('pay')
    const office = ROLE_TEMPLATES.filter((template) => template.audience === 'office' && template.grains.includes('pay')).map((template) => template.key)
    expect(office).toEqual(['owner'])
    expect(templateOf('finance')!.grains).not.toContain('pay')
    expect(FLOOR_GRAINS).toContain('pay')
    expect(['operator', 'cutting_operator', 'floor_inspector', 'team_leader'].every((key) => templateOf(key)!.grains.includes('pay'))).toBe(true)
    expect(templateOf('technician')!.grains).toEqual([])
    expect(heldGrains({ audience: 'system', grants: [] } as never).has('pay')).toBe(true)
    expect(heldGrains(null).has('pay')).toBe(false)
  })

  it('declares the three permissions; the view goes to the administrator and production manager, never the manage or the switch', () => {
    for (const name of PEOPLE_PIECERATES_PERMISSIONS) expect(FACTORY_PERMISSIONS.isDeclared(name)).toBe(true)
    expect(FACTORY_PERMISSIONS.get('people.piecerates.switch')!.risk).toBe('stepUp')
    for (const key of ['admin', 'production_manager']) expect(templateOf(key)!.permissions).toContain('people.piecerates.view')
    const managers = ROLE_TEMPLATES.filter((template) => template.key !== 'owner' && (template.permissions.includes('people.piecerates.manage') || template.permissions.includes('people.piecerates.switch')))
    expect(managers).toEqual([])
  })
})
