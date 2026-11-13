import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ITEM_KINDS } from '@nexus/factory-domain/product/materials/rules'
import { TOLERANCE_ACTIONS } from '@nexus/factory-domain/purchasing/po-depth/tolerances'
import { ApiError } from '../../../lib/api/errors'
import type { DesignScreen } from '../../../lib/design/design-screen'
import { LOCALES } from '../../../lib/i18n/locales'
import { CATALOGUE, messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { recordAddress } from '../../../lib/records/record-links'
import { OFFICE_PAGES } from '../../../shell/nav/office-nav'
import { officeArea } from '../nav'
import {
  ALL_DEFAULT,
  COMPANY_ID,
  KINDS,
  LEATHER_TANNERY,
  MESH_ONE,
  OLD_WORKSHOP,
  OWN_DEFAULT,
  PROTECTORS,
  REMINDERS_ALL,
  REMINDERS_DEFAULT,
  REMINDERS_FOLLOW,
  REMINDERS_OWN_ON,
  RULE_BIG,
  RULE_GROWS,
  RULE_PROSPECT,
  RULES_NONE,
  RULES_OFF,
  RULES_ON,
  SWITCH_AUDIT,
  TANNERY,
  TOLERANCE_AUDIT,
  TOLERANCES,
  TOLERANCES_FOLLOWING,
  ZIPS_EXACT,
} from './demo'
import { designScreen } from './fixtures'
import {
  addressOf,
  adminRuleHref,
  approvalStateOf,
  CONFIRM_HOURS,
  defaultChanges,
  defaultDraftOf,
  defaultProblems,
  defaultWrite,
  draftCreateBody,
  draftProblems,
  draftUpdateBody,
  exceptionsOf,
  followedDefaultOf,
  keepHeld,
  mayKeepTolerances,
  movable,
  ownDefaultOf,
  percentProblem,
  percentText,
  percentWords,
  poFactsOf,
  poRulesOf,
  queryOf,
  READ_PROBLEM_KEYS,
  readProblemOf,
  switchBody,
  switchChangedOf,
  switchHeld,
  switchWordsKey,
  toleranceDraftOf,
  tolerancesChangedOf,
  WRITE_PROBLEM_KEYS,
  writeProblemOf,
} from './model'

describe('the address', () => {
  it('reads and writes the scope, the exceptions filter and the dialog', () => {
    const params = (entries: Record<string, string>) => new URLSearchParams(entries)
    expect(addressOf(null)).toEqual({ scope: 'company', status: 'ACTIVE', tolerance: null })
    expect(addressOf(params({ scope: 'all', status: 'ARCHIVED', tolerance: 'new' }))).toEqual({ scope: 'all', status: 'ARCHIVED', tolerance: 'new' })
    expect(addressOf(params({ scope: 'x', status: 'y' }))).toEqual({ scope: 'company', status: 'ACTIVE', tolerance: null })
    expect(queryOf({ scope: 'company', status: 'ACTIVE', tolerance: null })).toBe('')
    expect(queryOf({ scope: 'all', status: 'ALL', tolerance: 'abc' })).toBe('?scope=all&status=ALL&tolerance=abc')
  })
  it('a rule opens in Admin › Automation (one editor); a delivery tolerance opens in its dialog here', () => {
    expect(adminRuleHref('/w/DEMO', 'r1')).toBe('/w/DEMO/admin/automation?view=approvals&rule=r1')
    expect(OFFICE_PAGES.has('/purchasing/settings')).toBe(true)
    expect(recordAddress({ type: 'DeliveryTolerance', id: 't1' }, OFFICE_PAGES)).toBe('/purchasing/settings?tolerance=t1')
  })
  it('the navigation row: Purchasing › Settings › Purchasing settings for purchasing.view, last', () => {
    const sections = officeArea.area.sections ?? []
    const last = sections[sections.length - 1]!
    expect(last.label).toBe('shell:nav.purchasing.settingsGroup')
    expect(last.items.map((item) => [item.href, item.permission])).toEqual([['/purchasing/settings', 'purchasing.view']])
  })
})

describe('PO approval: the engine’s purchase order rules, shown honestly', () => {
  it('lists only PURCHASE_ORDER rules: this company’s and every company’s, or all of them for every company', () => {
    expect(poRulesOf(RULES_OFF, 'company', COMPANY_ID).map((rule) => rule.id)).toEqual([RULE_BIG.id, RULE_GROWS.id, RULE_PROSPECT.id])
    const other = { ...RULE_BIG, id: 'other', companyId: 'another-company' }
    expect(poRulesOf({ ...RULES_OFF, rules: [...RULES_OFF.rules, other] }, 'company', COMPANY_ID).map((rule) => rule.id)).not.toContain('other')
    expect(poRulesOf({ ...RULES_OFF, rules: [...RULES_OFF.rules, other] }, 'all', COMPANY_ID).map((rule) => rule.id)).toContain('other')
    // A switched-on rule first.
    expect(poRulesOf(RULES_ON, 'company', COMPANY_ID)[0]!.active).toBe(true)
  })
  it('says whether any rule is on: none written, written but off (the default), on — and one switched on from a later date', () => {
    expect(approvalStateOf(poRulesOf(RULES_NONE, 'company', COMPANY_ID))).toMatchObject({ state: 'NONE', on: 0, total: 0 })
    expect(approvalStateOf(poRulesOf(RULES_OFF, 'company', COMPANY_ID))).toMatchObject({ state: 'OFF', on: 0, total: 3 })
    expect(approvalStateOf(poRulesOf(RULES_ON, 'company', COMPANY_ID))).toMatchObject({ state: 'ON', on: 1, total: 3 })
    const later = { ...RULE_GROWS, active: true, effectiveFrom: '2027-01-01T00:00:00.000Z' }
    expect(approvalStateOf([later], new Date('2026-11-12T10:00:00Z'))).toMatchObject({ state: 'OFF', on: 0, later: 1 })
  })
  it('what a rule may check comes from the kind, in the reader’s language', () => {
    expect(poFactsOf(KINDS, 'en')).toContain('value added since the last send')
    expect(poFactsOf(KINDS, 'it')).toContain('revisione')
    expect(poFactsOf(null, 'en')).toBeNull()
  })
})

describe('delivery tolerances', () => {
  it('the default is the scope’s own ACTIVE every-supplier, every-material row; a company follows every company’s', () => {
    expect(ownDefaultOf(TOLERANCES, 'company', COMPANY_ID)?.id).toBe(OWN_DEFAULT.id)
    expect(ownDefaultOf(TOLERANCES, 'all', COMPANY_ID)?.id).toBe(ALL_DEFAULT.id)
    expect(ownDefaultOf(TOLERANCES_FOLLOWING, 'company', COMPANY_ID)).toBeNull()
    expect(followedDefaultOf(TOLERANCES_FOLLOWING, 'company')?.id).toBe(ALL_DEFAULT.id)
    expect(followedDefaultOf(TOLERANCES, 'all')).toBeNull()
  })
  it('the exceptions are the rest of the scope, this company’s first, by status', () => {
    // Every supplier first (by material), then by supplier; every company's last.
    expect(exceptionsOf(TOLERANCES, 'company', COMPANY_ID, 'ACTIVE').map((row) => row.id)).toEqual([MESH_ONE.id, LEATHER_TANNERY.id, ZIPS_EXACT.id, PROTECTORS.id])
    expect(exceptionsOf(TOLERANCES, 'company', COMPANY_ID, 'ARCHIVED').map((row) => row.id)).toEqual([OLD_WORKSHOP.id])
    expect(exceptionsOf(TOLERANCES, 'all', COMPANY_ID, 'ALL').map((row) => row.id)).toEqual([PROTECTORS.id])
    // Neither default is listed: the form shows them.
    expect(exceptionsOf(TOLERANCES, 'company', COMPANY_ID, 'ALL').map((row) => row.id)).not.toContain(ALL_DEFAULT.id)
    expect(exceptionsOf(TOLERANCES, 'company', COMPANY_ID, 'ALL').map((row) => row.id)).not.toContain(OWN_DEFAULT.id)
  })
  it('percentages: 0 to 100, four decimals at most; said as the reader writes them', () => {
    expect(percentProblem('')).toBe('problem.percentNeeded')
    expect(percentProblem(120)).toBe('problem.percentRange')
    expect(percentProblem(-1)).toBe('problem.percentRange')
    expect(percentProblem(2.12345)).toBe('problem.percentPlaces')
    expect(percentProblem(2.5)).toBeNull()
    expect(percentText(2.5)).toBe('2.5')
    expect(percentText(5)).toBe('5')
    expect(percentWords('2.5', 'it')).toBe('2,5 %')
    expect(percentWords('2.5', 'en')).toBe('2.5 %')
  })
  it('the default form: empty without a row; counts what changed; sends a new row or only what changed', () => {
    expect(defaultDraftOf(null)).toEqual({ over: '', under: '', whenBeyond: 'BLOCK' })
    expect(defaultChanges(null, defaultDraftOf(null))).toBe(0)
    expect(defaultChanges(null, { over: 5, under: '', whenBeyond: 'BLOCK' })).toBe(1)
    expect(defaultProblems({ over: 5, under: '', whenBeyond: 'BLOCK' })).toEqual({ over: null, under: 'problem.percentNeeded' })
    expect(defaultChanges(OWN_DEFAULT, defaultDraftOf(OWN_DEFAULT))).toBe(0)
    expect(defaultChanges(OWN_DEFAULT, { over: 6, under: 3, whenBeyond: 'APPROVAL' })).toBe(2)
    expect(defaultWrite(null, { over: 5, under: 3, whenBeyond: 'BLOCK' }, 'company', COMPANY_ID)).toEqual({ kind: 'create', body: { companyId: COMPANY_ID, supplierId: null, itemId: null, itemKind: null, overPct: '5', underPct: '3', whenBeyond: 'BLOCK' } })
    expect(defaultWrite(null, { over: 2, under: 2, whenBeyond: 'BLOCK' }, 'all', COMPANY_ID)).toMatchObject({ kind: 'create', body: { companyId: null } })
    expect(defaultWrite(OWN_DEFAULT, { over: 6, under: 3, whenBeyond: 'APPROVAL' }, 'company', COMPANY_ID)).toEqual({ kind: 'update', id: OWN_DEFAULT.id, body: { version: OWN_DEFAULT.version, overPct: '6', whenBeyond: 'APPROVAL' } })
  })
  it('who may keep them: the API’s mayChange on the scope’s rows, else the permission; held in words', () => {
    expect(mayKeepTolerances(TOLERANCES, 'company', COMPANY_ID, false)).toBe(false)
    expect(mayKeepTolerances(TOLERANCES, 'company', COMPANY_ID, true)).toBe(true)
    expect(mayKeepTolerances(TOLERANCES.map((row) => ({ ...row, mayChange: row.companyId !== null })), 'all', COMPANY_ID, true)).toBe(false)
    expect(mayKeepTolerances([], 'all', COMPANY_ID, true)).toBe(true)
    expect(keepHeld({ may: false, scope: 'all', offline: false, busy: false })).toBe('held.noToleranceRightAll')
    expect(keepHeld({ may: true, scope: 'company', offline: true, busy: false })).toBe('held.offline')
    expect(keepHeld({ may: true, scope: 'company', offline: false, busy: true })).toBe('held.busy')
  })
  it('an exception names a supplier, a material or both; one active rule per scope; its scope never changes', () => {
    const fresh = toleranceDraftOf(null, COMPANY_ID)
    expect(draftProblems(fresh, TOLERANCES)).toEqual({ scope: 'problem.exceptionNeedsScope', over: 'problem.percentNeeded', under: 'problem.percentNeeded' })
    expect(draftProblems({ ...fresh, materialMode: 'KIND', over: 1, under: 1 }, TOLERANCES)).toMatchObject({ material: 'problem.kindNeeded' })
    expect(draftProblems({ ...fresh, materialMode: 'ITEM', over: 1, under: 1 }, TOLERANCES)).toMatchObject({ material: 'problem.materialNeeded' })
    expect(draftProblems({ ...fresh, supplierId: TANNERY.id, materialMode: 'KIND', itemKind: 'LEATHER', over: 1, under: 1 }, TOLERANCES)).toEqual({ scope: 'problem.sameScope' })
    expect(draftProblems({ ...fresh, supplierId: TANNERY.id, materialMode: 'KIND', itemKind: 'LINING', over: 1, under: 1 }, TOLERANCES)).toEqual({})
    // Every company's rule for the tannery's leather is another scope.
    expect(draftProblems({ ...fresh, companyId: null, supplierId: TANNERY.id, materialMode: 'KIND', itemKind: 'LEATHER', over: 1, under: 1 }, TOLERANCES)).toEqual({})
    expect(draftCreateBody({ ...fresh, supplierId: TANNERY.id, materialMode: 'KIND', itemKind: 'LINING', itemId: 'ignored', over: 4, under: 2.5, note: '  agreed  ' })).toEqual({ companyId: COMPANY_ID, supplierId: TANNERY.id, itemId: null, itemKind: 'LINING', overPct: '4', underPct: '2.5', whenBeyond: 'BLOCK', note: 'agreed' })
    const kept = toleranceDraftOf(LEATHER_TANNERY, COMPANY_ID)
    expect(kept).toMatchObject({ id: LEATHER_TANNERY.id, materialMode: 'KIND', itemKind: 'LEATHER', over: 8, under: 5 })
    expect(draftProblems(kept, TOLERANCES)).toEqual({})
    expect(draftUpdateBody(LEATHER_TANNERY, kept)).toBeNull()
    expect(draftUpdateBody(LEATHER_TANNERY, { ...kept, under: 4, note: '' })).toEqual({ version: LEATHER_TANNERY.version, underPct: '4', note: null })
  })
  it('bulk moves take only the rows in the other state that the person may change', () => {
    expect(movable(TOLERANCES, [LEATHER_TANNERY.id, OLD_WORKSHOP.id], 'archive').map((row) => row.id)).toEqual([LEATHER_TANNERY.id])
    expect(movable(TOLERANCES, [LEATHER_TANNERY.id, OLD_WORKSHOP.id], 'reactivate').map((row) => row.id)).toEqual([OLD_WORKSHOP.id])
    expect(movable(TOLERANCES.map((row) => ({ ...row, mayChange: false })), [LEATHER_TANNERY.id], 'archive')).toEqual([])
  })
  it('"Changed by": the audit trail’s name for a row shown, else the newest row’s time', () => {
    expect(tolerancesChangedOf(TOLERANCES, TOLERANCE_AUDIT)).toEqual({ at: TOLERANCE_AUDIT[0]!.at, by: 'Anna Demo' })
    expect(tolerancesChangedOf(TOLERANCES, null)).toMatchObject({ by: null })
    expect(tolerancesChangedOf([], null)).toBeNull()
  })
})

describe('confirmation: the Owner’s switch', () => {
  it('48 hours by default (W2a)', () => {
    expect(CONFIRM_HOURS).toBe(48)
  })
  it('writes the scope’s own row at its version, or makes it (no version)', () => {
    expect(switchBody(REMINDERS_DEFAULT, true, 'company', COMPANY_ID)).toEqual({ companyId: COMPANY_ID, on: true })
    expect(switchBody(REMINDERS_OWN_ON, false, 'company', COMPANY_ID)).toEqual({ companyId: COMPANY_ID, on: false, version: 2 })
    // A company that follows every company makes its own row on its first change.
    expect(switchBody(REMINDERS_FOLLOW, true, 'company', COMPANY_ID)).toEqual({ companyId: COMPANY_ID, on: true })
    expect(switchBody(REMINDERS_ALL, true, 'all', COMPANY_ID)).toEqual({ companyId: null, on: true, version: 1 })
  })
  it('held: reading, busy, not the Owner (this company / every company), offline', () => {
    expect(switchHeld(null, 'company', false, false)).toBe('held.reading')
    expect(switchHeld({ ...REMINDERS_DEFAULT, mayChange: false }, 'company', false, false)).toBe('held.noSwitch')
    expect(switchHeld({ ...REMINDERS_ALL, mayChange: false }, 'all', false, false)).toBe('held.noSwitchAll')
    expect(switchHeld(REMINDERS_DEFAULT, 'company', true, false)).toBe('held.offline')
    expect(switchHeld(REMINDERS_DEFAULT, 'company', false, false)).toBeNull()
  })
  it('its words say on or off and where it comes from; who changed it from the audit trail', () => {
    expect(switchWordsKey(REMINDERS_DEFAULT)).toBe('switch.off.DEFAULT')
    expect(switchWordsKey(REMINDERS_OWN_ON)).toBe('switch.on.COMPANY')
    expect(switchChangedOf(REMINDERS_OWN_ON, 'company', SWITCH_AUDIT)).toEqual({ at: SWITCH_AUDIT[0]!.at, by: 'Owner Demo' })
    expect(switchChangedOf(REMINDERS_OWN_ON, 'company', null)).toMatchObject({ by: null })
    expect(switchChangedOf(REMINDERS_DEFAULT, 'company', SWITCH_AUDIT)).toBeNull()
  })
})

describe('the API’s refusals in this page’s words', () => {
  const error = (kind: ConstructorParameters<typeof ApiError>[0], status: number, code: string, message: string, issues: { path: string; message: string }[] = []) => new ApiError(kind, status, code, message, null, issues)
  it('reads', () => {
    expect(readProblemOf(error('unavailable', 503, 'x', 'down'))).toBe('problem.read.unavailable')
    expect(readProblemOf(new Error('x'))).toBe('problem.read.internal')
  })
  it('writes', () => {
    expect(writeProblemOf(error('conflict', 409, 'conflict', 'These settings changed since they were read', [{ path: 'body/version', message: 'The current version is 3.' }]), 'company')).toEqual({ key: 'problem.write.moved', reload: true, fields: {} })
    expect(writeProblemOf(error('conflict', 409, 'conflict', 'An active delivery tolerance of this company, supplier and material already exists: change that one, or archive it first.'), 'company')).toMatchObject({ key: 'problem.write.sameScope', reload: true })
    expect(writeProblemOf(error('conflict', 409, 'conflict', 'The tolerance is archived: reactivate it to change it.'), 'company')).toMatchObject({ key: 'problem.write.state' })
    expect(writeProblemOf(error('invalid', 400, 'validation_failed', 'x', [{ path: 'body/overPct', message: 'x' }]), 'company')).toEqual({ key: 'problem.write.invalid', reload: false, fields: { overPct: 'problem.percentRange' } })
    expect(writeProblemOf(error('forbidden', 403, 'forbidden', 'x'), 'all').key).toBe('problem.write.forbiddenAll')
    expect(writeProblemOf(error('forbidden', 403, 'forbidden', 'x'), 'company').key).toBe('problem.write.forbidden')
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
const PREFIXES = ['head', 'live', 'scope', 'noAccess', 'card', 'common', 'approval', 'meaning', 'tolerance', 'itemKind', 'row', 'bulk', 'dialog', 'confirm', 'switch', 'alert', 'held', 'problem', 'done', 'stepUp', 'keys']
const literalKeys = (): string[] => [
  ...new Set(
    sources(HERE).flatMap((file) => {
      const text = readFileSync(file, 'utf8')
      return [...text.matchAll(/\bt\(\s*'([a-zA-Z][\w.]+)'/g), ...text.matchAll(new RegExp(`'((?:${PREFIXES.join('|')})\\.[a-zA-Z][\\w.]+)'`, 'g'))].map((match) => match[1]!)
    }),
  ),
].filter((key) => !['approval.rule_changed', 'alert.rule_changed'].includes(key))
const built = [
  ...['NONE', 'OFF', 'ON'].map((state) => `approval.state.${state}`),
  ...['REVIEWED', 'APPROVED', 'RELEASED', 'VERIFIED'].map((meaning) => `meaning.${meaning}`),
  ...TOLERANCE_ACTIONS.flatMap((action) => [`tolerance.beyondTitle.${action}`, `tolerance.beyondHint.${action}`, `tolerance.beyondShort.${action}`]),
  ...['ACTIVE', 'ARCHIVED', 'ALL'].map((status) => `tolerance.status.${status}`),
  ...ITEM_KINDS.map((kind) => `itemKind.${kind}`),
  ...['on', 'off'].flatMap((state) => ['COMPANY', 'TENANT', 'DEFAULT'].map((source) => `switch.${state}.${source}`)),
  ...['connecting', 'live', 'offline'].map((state) => `live.${state}`),
  ...READ_PROBLEM_KEYS.map((kind) => `problem.read.${kind}`),
  ...WRITE_PROBLEM_KEYS.map((kind) => `problem.write.${kind}`),
  ...['wrong', 'locked', 'unavailable'].map((kind) => `stepUp.problem.${kind}`),
]

describe('every key the page names exists in it and en', () => {
  for (const locale of LOCALES) {
    it(`purchasing-settings (${locale})`, () => {
      const dictionary = CATALOGUE[locale]?.['purchasing-settings'] ?? {}
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
    it(`SCR-256 in ${locale}: ${designScreen.cases.length} cases`, () => {
      for (const item of designScreen.cases) {
        // Permission names (purchasing.view) are words, not keys.
        const html = render(item.model, locale).replace(/https?:\/\/[^"\s<]+/g, '').replace(/\b(?:purchasing|approvals|alerts|parties|product|audit)\.[a-zA-Z]+(?:\.[a-zA-Z]+)?\b/g, '')
        expect(html.match(LEFT_KEY)?.[0] ?? null, `SCR-256/${item.id} (${locale})`).toBeNull()
      }
    })
  }
})

describe('honest states (Owner answers 11-10)', () => {
  const html = (id: string) => render(designScreen.cases.find((item) => item.id === id)!.model, 'en')
  it('nobody approves their own request, the Owner included; no rule is on by default, and the page says so', () => {
    expect(html('owner')).toContain('Nobody approves their own request, the Owner included.')
    expect(html('owner')).toContain('3 rules written, none switched on')
    expect(html('rules-none')).toContain('No approval rule for purchase orders')
  })
  it('the reminder switch is the Owner’s, off by default; switching it on warns and asks for a code', () => {
    expect(html('owner')).toContain('Off (never switched on)')
    expect(html('buyer')).toContain('Only the Owner switches automatic reminders')
    expect(html('switch-on')).toContain('mails real suppliers')
  })
  // B-W2b-377: the receipt beyond the tolerance waits for the buyer's yes (RECEIPT_OVER_TOLERANCE).
  it('APPROVAL beyond a tolerance says the receipt waits for a yes before it is posted', () => {
    expect(html('owner')).toContain('The receipt waits for a yes from the buyer before it is posted')
  })
  it('no money anywhere on the page', () => {
    for (const item of designScreen.cases) expect(render(item.model, 'en'), item.id).not.toMatch(/€|EUR\b/)
  })
})
