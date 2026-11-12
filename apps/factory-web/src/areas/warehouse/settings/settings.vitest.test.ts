import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { EVIDENCE_RULES } from '@nexus/factory-domain/quality/lab/rules'
import { LOCATION_KINDS } from '@nexus/factory-domain/inventory/locations/rules'
import { ApiError } from '../../../lib/api/errors'
import type { DesignScreen } from '../../../lib/design/design-screen'
import { LOCALES } from '../../../lib/i18n/locales'
import { CATALOGUE, messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { OFFICE_PAGES } from '../../../shell/nav/office-nav'
import { officeArea } from '../nav'
import {
  APPROVALS_OFF,
  BIN_A1,
  COMPANY_ID,
  DEFAULT_LEATHER_PUT,
  DEFAULT_PUT_AWAY,
  DEFAULT_QUALITY,
  DEFAULTS,
  DEFAULTS_AUDIT,
  DOCK,
  FINISHED,
  LEATHER_ROOM,
  QUARANTINE,
  RULE_BIG,
  RULE_FINANCE,
  RULES_AUDIT,
  RULES_COMPANY,
  RULES_FOLLOWING,
  RULES_TENANT,
  RULES_WAITS,
  SEPARATION_COMPANY,
  SEPARATION_OFF,
  SEPARATION_TENANT,
  SITE_A,
  SITES,
  TENANT_ID,
  withoutCost,
} from './demo'
import { designScreen } from './fixtures'
import {
  addressOf,
  adjustmentRulesOf,
  adjustStateOf,
  amountDraftOf,
  amountLoosens,
  amountProblem,
  amountValueOf,
  amountWords,
  cardChangedOf,
  cellKey,
  cellOptions,
  daysDraftOf,
  daysLoosens,
  daysProblem,
  daysValueOf,
  DEFAULT_PURPOSES,
  defaultChanges,
  defaultKindsOf,
  defaultsChangedOf,
  defaultWrites,
  dirtyCards,
  fallbackFor,
  HELD_ITEM_KINDS,
  queryOf,
  READ_PROBLEM_KEYS,
  readProblemOf,
  reasonProblem,
  reading,
  ready,
  rowIdOf,
  rowVersion,
  rulesHeld,
  separationBody,
  separationDraftOf,
  separationLoosens,
  siteOf,
  sitesOfScope,
  switchAfter,
  WRITE_PROBLEM_KEYS,
  writeProblemOf,
} from './model'

describe('the address and the navigation', () => {
  it('reads and writes the scope and the site', () => {
    const params = (entries: Record<string, string>) => new URLSearchParams(entries)
    expect(addressOf(null)).toEqual({ scope: 'company', site: null })
    expect(addressOf(params({ scope: 'all', site: 's1' }))).toEqual({ scope: 'all', site: 's1' })
    expect(addressOf(params({ scope: 'x' }))).toEqual({ scope: 'company', site: null })
    expect(queryOf({ scope: 'company', site: null })).toBe('')
    expect(queryOf({ scope: 'all', site: 's1' })).toBe('?scope=all&site=s1')
  })
  it('the row: Warehouse › Settings › Warehouse rules for inventory.stock.view, last in Settings', () => {
    expect(OFFICE_PAGES.has('/warehouse/settings')).toBe(true)
    const settings = (officeArea.area.sections ?? []).find((section) => section.id === 'warehouse-settings')!
    const last = settings.items[settings.items.length - 1]!
    expect([last.id, last.href, last.permission, last.label]).toEqual(['warehouse-rules', '/warehouse/settings', 'inventory.stock.view', 'shell:nav.warehouse.rules'])
  })
  it('the scope writes one InventorySettings row: the company’s, or every company’s (the tenant’s id)', () => {
    expect(rowIdOf('company', COMPANY_ID, TENANT_ID)).toBe(COMPANY_ID)
    expect(rowIdOf('all', COMPANY_ID, TENANT_ID)).toBe(TENANT_ID)
    // Both cards' reads carry the shared row's version.
    expect(rowVersion(RULES_COMPANY, SEPARATION_COMPANY)).toBe(3)
    expect(rowVersion(null, SEPARATION_OFF)).toBe(4)
  })
})

describe('separation of duties', () => {
  it('on by default; switching one off loosens (the reason and a code); on again asks nothing', () => {
    const draft = separationDraftOf(SEPARATION_COMPANY)
    expect(draft).toEqual({ COUNTER_NOT_APPROVER: null, RECEIVER_NOT_MATCHER: null })
    const off = { ...draft, COUNTER_NOT_APPROVER: false }
    expect(separationLoosens(SEPARATION_COMPANY, off, 'company', SEPARATION_TENANT)).toEqual(['COUNTER_NOT_APPROVER'])
    expect(switchAfter('COUNTER_NOT_APPROVER', 'company', off, SEPARATION_COMPANY, SEPARATION_TENANT)).toEqual({ value: false, source: 'COMPANY' })
    const back = { ...separationDraftOf(SEPARATION_OFF), RECEIVER_NOT_MATCHER: true }
    expect(separationLoosens(SEPARATION_OFF, back, 'company', SEPARATION_TENANT)).toEqual([])
    // Following every company again (on) tightens.
    expect(separationLoosens(SEPARATION_OFF, { ...separationDraftOf(SEPARATION_OFF), RECEIVER_NOT_MATCHER: null }, 'company', SEPARATION_TENANT)).toEqual([])
    expect(switchAfter('RECEIVER_NOT_MATCHER', 'company', { ...separationDraftOf(SEPARATION_OFF), RECEIVER_NOT_MATCHER: null }, SEPARATION_OFF, SEPARATION_TENANT)).toEqual({ value: true, source: 'DEFAULT' })
  })
  it('sends only the switch that changed, at the row’s version, with the reason', () => {
    const off = { ...separationDraftOf(SEPARATION_COMPANY), COUNTER_NOT_APPROVER: false }
    expect(separationBody(SEPARATION_COMPANY, off, 'company', COMPANY_ID, 3, '  one counter  ')).toEqual({ companyId: COMPANY_ID, version: 3, counterNotApprover: false, reason: 'one counter' })
    expect(separationBody(SEPARATION_TENANT, { ...separationDraftOf(SEPARATION_TENANT), RECEIVER_NOT_MATCHER: true }, 'all', COMPANY_ID, 1, '')).toEqual({ companyId: null, version: 1, receiverNotMatcher: true })
  })
  it('the reason: 1 to 500 characters', () => {
    expect(reasonProblem('  ')).toBe('problem.reasonNeeded')
    expect(reasonProblem('x'.repeat(501))).toBe('problem.reasonLong')
    expect(reasonProblem('why')).toBeNull()
  })
})

describe('posting dates', () => {
  it('a company’s own days, or as every company; every company’s: a limit or none', () => {
    expect(daysDraftOf(RULES_COMPANY, 'company')).toEqual({ mode: 'OWN', days: 7 })
    expect(daysDraftOf(RULES_FOLLOWING, 'company')).toEqual({ mode: 'FOLLOW', days: '' })
    expect(daysDraftOf({ ...RULES_TENANT, postingDates: { ...RULES_TENANT.postingDates, own: null } }, 'all')).toEqual({ mode: 'NONE', days: '' })
    expect(daysValueOf({ mode: 'FOLLOW', days: '' })).toBeNull()
    expect(daysProblem({ mode: 'OWN', days: '' })).toBe('problem.daysNeeded')
    expect(daysProblem({ mode: 'OWN', days: 400 })).toBe('problem.daysRange')
    expect(daysProblem({ mode: 'OWN', days: 0 })).toBeNull()
  })
  it('more days back, or no limit, loosens; fewer days, or following a tighter every company, does not', () => {
    expect(daysLoosens(RULES_COMPANY, { mode: 'OWN', days: 14 }, 'company', RULES_TENANT)).toBe(true)
    expect(daysLoosens(RULES_COMPANY, { mode: 'OWN', days: 2 }, 'company', RULES_TENANT)).toBe(false)
    expect(daysLoosens(RULES_COMPANY, { mode: 'FOLLOW', days: '' }, 'company', RULES_TENANT)).toBe(false)
    expect(daysLoosens(RULES_TENANT, { mode: 'NONE', days: '' }, 'all', null)).toBe(true)
    // Every company's rules not readable: following them may loosen (not known), so it asks.
    expect(daysLoosens(RULES_COMPANY, { mode: 'FOLLOW', days: '' }, 'company', null)).toBe(true)
  })
})

describe('adjustment approval (the cost grain)', () => {
  it('the value in the currency’s major units; minor units sent', () => {
    expect(amountDraftOf(RULES_COMPANY, 'company')).toEqual({ mode: 'OWN', amount: 500 })
    expect(amountValueOf({ mode: 'OWN', amount: 1500 }, 'EUR')).toBe(150000)
    expect(amountWords(50000, 'EUR', 'en')).toBe('€500.00')
    expect(amountProblem({ mode: 'OWN', amount: '' }, 'EUR')).toBe('problem.amountNeeded')
    expect(amountProblem({ mode: 'OWN', amount: -1 }, 'EUR')).toBe('problem.amountRange')
  })
  it('a higher value, or none, loosens; a lower one does not', () => {
    expect(amountLoosens(RULES_COMPANY, { mode: 'OWN', amount: 1500 }, 'company', RULES_TENANT)).toBe(true)
    expect(amountLoosens(RULES_COMPANY, { mode: 'OWN', amount: 200 }, 'company', RULES_TENANT)).toBe(false)
    expect(amountLoosens(RULES_COMPANY, { mode: 'FOLLOW', amount: '' }, 'company', RULES_TENANT)).toBe(true)
  })
  it('says honestly whether an adjustment waits: no value, a value but no rule on (the default), a rule on', () => {
    expect(adjustStateOf({ ...RULES_COMPANY, adjustmentApproval: { ...RULES_COMPANY.adjustmentApproval, inForce: { amount: null, source: 'DEFAULT', set: false } } })).toBe('NO_VALUE')
    expect(adjustStateOf(RULES_COMPANY)).toBe('NO_RULE')
    expect(adjustStateOf(RULES_WAITS)).toBe('WAITS')
  })
  it('the STOCK_ADJUSTMENT rules only: this company’s and every company’s', () => {
    expect(adjustmentRulesOf(APPROVALS_OFF, 'company', COMPANY_ID).map((rule) => rule.id)).toEqual([RULE_BIG.id, RULE_FINANCE.id])
    expect(adjustmentRulesOf({ ...APPROVALS_OFF, rules: [...APPROVALS_OFF.rules, { ...RULE_BIG, id: 'other', companyId: 'another' }] }, 'company', COMPANY_ID).map((rule) => rule.id)).not.toContain('other')
  })
  it('without the cost grain the value is not drawn and never counts as a change', () => {
    const view = withoutCost(RULES_COMPANY)
    expect(view.adjustmentApproval.own).toBeUndefined()
    expect(dirtyCards({ rules: ready(view), separation: ready(SEPARATION_COMPANY), separationDraft: separationDraftOf(SEPARATION_COMPANY), daysDraft: daysDraftOf(view, 'company'), amountDraft: { mode: 'OWN', amount: 9 }, alertsDraft: null, defaults: ready(DEFAULTS), defaultsDraft: {} })).toEqual([])
  })
})

describe('default locations', () => {
  it('the rows: the site’s fallback first, then each kind kept, typed or added, in the kinds’ order', () => {
    expect(defaultKindsOf(DEFAULTS, {}, [])).toEqual([null, 'LEATHER', 'FINISHED'])
    expect(defaultKindsOf(DEFAULTS, { [cellKey('ISSUE', 'LINING')]: null }, ['TRIM'])).toEqual([null, 'LEATHER', 'LINING', 'TRIM', 'FINISHED'])
  })
  it('a cell offers only active places whose kind may serve the purpose and hold the goods', () => {
    expect(cellOptions(SITE_A, 'QUALITY', null).map((place) => place.id)).toEqual([QUARANTINE.id])
    expect(cellOptions(SITE_A, 'RECEIVING', 'FINISHED').map((place) => place.code)).not.toContain('DEMO-L1')
    expect(cellOptions(SITE_A, 'RECEIVING', 'FINISHED').map((place) => place.id)).toContain(FINISHED.id)
    // A line-side rack never holds finished garments.
    expect(cellOptions(SITE_A, 'ISSUE', 'FINISHED').map((place) => place.kind)).not.toContain('PRODUCTION')
  })
  it('an empty kind cell follows the fallback where it may hold the goods', () => {
    expect(fallbackFor(DEFAULTS, {}, SITE_A, 'PUT_AWAY', 'TRIM')?.id).toBe(BIN_A1.id)
    expect(fallbackFor(DEFAULTS, {}, SITE_A, 'RECEIVING', 'LEATHER')?.id).toBe(DOCK.id)
    expect(fallbackFor(DEFAULTS, { [cellKey('PUT_AWAY', null)]: null }, SITE_A, 'PUT_AWAY', 'TRIM')).toBeNull()
  })
  it('one write per changed cell, at the version read (none for a new one); a cleared cell sends null', () => {
    const draft = { [cellKey('PUT_AWAY', 'LEATHER')]: BIN_A1.id, [cellKey('QUALITY', null)]: null, [cellKey('ISSUE', 'TRIM')]: LEATHER_ROOM.id, [cellKey('RECEIVING', null)]: DOCK.id }
    expect(defaultChanges(DEFAULTS, draft)).toHaveLength(3)
    expect(defaultWrites(DEFAULTS, draft, SITE_A.id)).toEqual([
      { siteId: SITE_A.id, itemKind: 'LEATHER', purpose: 'PUT_AWAY', locationId: BIN_A1.id, version: DEFAULT_LEATHER_PUT.version },
      { siteId: SITE_A.id, itemKind: null, purpose: 'QUALITY', locationId: null, version: DEFAULT_QUALITY.version },
      { siteId: SITE_A.id, itemKind: 'TRIM', purpose: 'ISSUE', locationId: LEATHER_ROOM.id },
    ])
  })
  it('the sites of the scope, the address’s or the first', () => {
    expect(sitesOfScope(SITES, 'company', COMPANY_ID).map((site) => site.code)).toEqual(['DEMO-P1', 'DEMO-P2'])
    expect(sitesOfScope(SITES, 'all', COMPANY_ID)).toHaveLength(3)
    expect(siteOf(SITES, { scope: 'company', site: SITES[1]!.id })?.id).toBe(SITES[1]!.id)
    expect(siteOf(SITES, { scope: 'company', site: 'gone' })?.id).toBe(SITES[0]!.id)
  })
})

describe('held, "Changed by" and what is unsaved', () => {
  it('held in words: reading, busy, no right (this company / every company), offline', () => {
    expect(rulesHeld({ may: null, scope: 'company', offline: false, busy: false })).toBe('held.reading')
    expect(rulesHeld({ may: false, scope: 'all', offline: false, busy: false })).toBe('held.noRightAll')
    expect(rulesHeld({ may: true, scope: 'company', offline: true, busy: false })).toBe('held.offline')
    expect(rulesHeld({ may: true, scope: 'company', offline: false, busy: false })).toBeNull()
  })
  it('a card’s last change from the audit trail (its own card), else the row’s, else never', () => {
    expect(cardChangedOf('POSTING_DATES', RULES_COMPANY, RULES_AUDIT)).toEqual({ at: RULES_AUDIT[0]!.at, by: 'Anna Demo' })
    // No save of this card in the entries read (seeded, or older): the row's own last change, said as the rules'.
    expect(cardChangedOf('LOW_STOCK_ALERTS', RULES_COMPANY, RULES_AUDIT)).toEqual({ at: RULES_COMPANY.updatedAt, by: 'Anna Demo', row: true })
    expect(cardChangedOf('POSTING_DATES', RULES_COMPANY, null)).toEqual({ at: RULES_COMPANY.updatedAt, by: 'Anna Demo', row: true })
    expect(cardChangedOf('POSTING_DATES', RULES_FOLLOWING, RULES_AUDIT)).toBeNull()
    expect(defaultsChangedOf(DEFAULTS, DEFAULTS_AUDIT)).toEqual({ at: DEFAULTS_AUDIT[0]!.at, by: 'Anna Demo' })
    expect(defaultsChangedOf([DEFAULT_PUT_AWAY], null)).toEqual({ at: DEFAULT_PUT_AWAY.updatedAt, by: null })
  })
  it('the cards holding a change, in the page’s order', () => {
    const state = { rules: ready(RULES_COMPANY), separation: ready(SEPARATION_COMPANY), separationDraft: { ...separationDraftOf(SEPARATION_COMPANY), COUNTER_NOT_APPROVER: false }, daysDraft: { mode: 'OWN' as const, days: 2 }, amountDraft: amountDraftOf(RULES_COMPANY, 'company'), alertsDraft: false, defaults: ready(DEFAULTS), defaultsDraft: { [cellKey('QUALITY', null)]: null } }
    expect(dirtyCards(state)).toEqual(['separation', 'posting', 'defaults', 'alerts'])
    expect(dirtyCards({ ...state, rules: reading(), separation: reading() })).toEqual(['defaults'])
  })
})

describe('the API’s refusals in this page’s words', () => {
  const error = (kind: ConstructorParameters<typeof ApiError>[0], status: number, code: string, message: string, issues: { path: string; message: string }[] = []) => new ApiError(kind, status, code, message, null, issues)
  it('reads', () => {
    expect(readProblemOf(error('unavailable', 503, 'x', 'down'))).toBe('problem.read.unavailable')
    expect(readProblemOf(new Error('x'))).toBe('problem.read.internal')
  })
  it('writes: moved (read again), the reason asked, a place refused, no cost, no right', () => {
    expect(writeProblemOf(error('conflict', 409, 'conflict', 'stale', [{ path: 'body/version', message: 'x' }]), 'company')).toEqual({ key: 'problem.write.moved', reload: true, reason: false })
    expect(writeProblemOf(error('invalid', 400, 'validation_failed', 'x', [{ path: 'body/reason', message: 'x' }]), 'company')).toEqual({ key: 'problem.write.reasonNeeded', reload: false, reason: true })
    expect(writeProblemOf(error('invalid', 400, 'validation_failed', 'x', [{ path: 'body/locationId', message: 'x' }]), 'company').key).toBe('problem.write.placeRefused')
    expect(writeProblemOf(error('forbidden', 403, 'forbidden', 'The value of an adjustment is a cost: changing it needs the cost grain.'), 'company').key).toBe('problem.write.noCost')
    expect(writeProblemOf(error('forbidden', 403, 'forbidden', 'x'), 'all').key).toBe('problem.write.forbiddenAll')
    expect(writeProblemOf(new Error('x'), 'company').key).toBe('problem.write.internal')
  })
})

// ---- every key and every design case ------------------------------------------------------------------------------------

const HERE = fileURLToPath(new URL('.', import.meta.url))
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sources(path)
    return /\.tsx?$/.test(entry.name) && !entry.name.includes('.vitest.') && entry.name !== 'fixtures.ts' && entry.name !== 'demo.ts' ? [path] : []
  })
}
const PREFIXES = ['head', 'live', 'scope', 'noAccess', 'card', 'common', 'source', 'reason', 'sod', 'posting', 'adjust', 'alerts', 'defaults', 'purpose', 'purposeHint', 'itemKind', 'locationKind', 'crvi', 'held', 'problem', 'done', 'stepUp', 'keys']
const literalKeys = (): string[] => [
  ...new Set(
    sources(HERE).flatMap((file) => {
      const text = readFileSync(file, 'utf8')
      return [...text.matchAll(/\bt\(\s*'([a-zA-Z][\w.]+)'/g), ...text.matchAll(new RegExp(`'((?:${PREFIXES.join('|')})\\.[a-zA-Z][\\w.]+)'`, 'g'))].map((match) => match[1]!)
    }),
  ),
].filter((key) => !['approval.rule_changed', 'quality.settings_changed', 'inventory.rules_changed', 'inventory.default_location_changed', 'inventory.rules.save', 'inventory.stock.view', 'inventory.rules.manage', 'inventory.locations.view', 'inventory.locations.manage', 'quality.lots.view'].includes(key))
const RULES = ['COUNTER_NOT_APPROVER', 'RECEIVER_NOT_MATCHER']
const built = [
  ...RULES.flatMap((rule) => ['title', 'on', 'off', 'where'].map((part) => `sod.rule.${rule}.${part}`)),
  ...['OWN', 'FOLLOW', 'LIMIT', 'NONE'].flatMap((mode) => [`posting.mode.${mode}`, `adjust.mode.${mode}`]),
  ...['NO_VALUE', 'NO_RULE', 'WAITS', 'UNKNOWN'].map((state) => `adjust.state.${state}`),
  ...['COMPANY', 'TENANT', 'ALL_OWN', 'DEFAULT'].map((source) => `source.${source}`),
  ...DEFAULT_PURPOSES.flatMap((purpose) => [`purpose.${purpose}`, `purposeHint.${purpose}`, `defaults.ownRule.${purpose}`]),
  ...HELD_ITEM_KINDS.map((kind) => `itemKind.${kind}`),
  ...LOCATION_KINDS.map((kind) => `locationKind.${kind}`),
  ...EVIDENCE_RULES.map((rule) => `crvi.rule.${rule}`),
  ...['separation', 'separationOff', 'posting', 'postingLoosened', 'adjust', 'adjustLoosened', 'alerts', 'defaults', 'defaultsSome'].map((key) => `done.${key}`),
  ...['separation', 'posting', 'adjust'].map((card) => `stepUp.sentence.${card}`),
  ...['connecting', 'live', 'offline'].map((state) => `live.${state}`),
  ...READ_PROBLEM_KEYS.map((kind) => `problem.read.${kind}`),
  ...WRITE_PROBLEM_KEYS.map((kind) => `problem.write.${kind}`),
  ...['wrong', 'locked', 'unavailable'].map((kind) => `stepUp.problem.${kind}`),
]

describe('every key the page names exists in it and en', () => {
  for (const locale of LOCALES) {
    it(`warehouse-settings (${locale})`, () => {
      const dictionary = CATALOGUE[locale]?.['warehouse-settings'] ?? {}
      const has = (key: string) => key in dictionary || `${key}_other` in dictionary
      const keys = [...literalKeys(), ...built]
      expect(keys.length).toBeGreaterThan(200)
      expect(keys.filter((key) => !has(key))).toEqual([])
    })
  }
})

const LEFT_KEY = new RegExp(`\\b(?:${PREFIXES.join('|')})\\.[a-zA-Z]+(?:\\.[a-zA-Z_]+)*\\b`)

function render(model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = (designScreen as DesignScreen<unknown>).view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(View, { model })))
}

describe('every design case draws in both languages with no key left on screen', () => {
  for (const locale of LOCALES) {
    it(`SCR-258 in ${locale}: ${designScreen.cases.length} cases`, () => {
      for (const item of designScreen.cases) {
        // Permission names (inventory.rules.manage) are words, not keys.
        const html = render(item.model, locale).replace(/https?:\/\/[^"\s<]+/g, '').replace(/\b(?:inventory|approvals|quality|money|audit)\.[a-zA-Z]+(?:\.[a-zA-Z]+)?\b/g, '')
        expect(html.match(LEFT_KEY)?.[0] ?? null, `SCR-258/${item.id} (${locale})`).toBeNull()
      }
    })
  }
})

describe('honest states (Owner answers 11-10)', () => {
  const html = (id: string, locale: (typeof LOCALES)[number] = 'en') => render(designScreen.cases.find((item) => item.id === id)!.model, locale)
  it('nobody approves their own request, the Owner included; no approval rule is on by default, and the page says so', () => {
    expect(html('owner')).toContain('Nobody approves their own request, the Owner included.')
    expect(html('owner')).toContain('no approval rule for stock adjustments is switched on')
    expect(html('owner')).toContain('No approval rule is switched on by default')
    expect(html('adjust-none-written')).toContain('No approval rule for stock adjustments')
    expect(html('owner', 'it')).toContain('Nessuno approva la propria richiesta, nemmeno il titolare.')
  })
  it('switching a separation rule off asks the reason and a code; tightening asks neither', () => {
    expect(html('sod-turning-off')).toContain('Save asks why, then a fresh code')
    expect(html('posting-loosened')).toContain('Save (asks for a code)')
    expect(html('posting-tighter')).not.toContain('Save (asks for a code)')
  })
  it('the Cr VI rule is shown with a link to where it lives, never edited here', () => {
    expect(html('owner')).toContain('A supplier report covering the article and period')
    expect(html('owner')).toContain('/compliance/settings?tab=cr6')
  })
  it('no money without the cost grain', () => {
    for (const id of ['warehouse', 'reader']) expect(html(id), id).not.toMatch(/€|EUR\b/)
    expect(html('owner')).toMatch(/€/)
  })
})
