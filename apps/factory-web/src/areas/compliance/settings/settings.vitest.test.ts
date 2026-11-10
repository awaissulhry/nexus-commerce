import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { CHANGE_KINDS, CHANGE_STATUSES, IMPACTS, REGULATION_KINDS, REGULATION_STATUSES } from '@nexus/factory-domain/compliance/register-of-rules/rules'
import { OPERATOR_ROLES, SCOPE_LEVELS } from '@nexus/factory-domain/compliance/operators/rules'
import { CELL_STATES, PHRASE_KINDS, TRANSLATION_STATUSES } from '@nexus/factory-domain/compliance/phrases/rules'
import { COMPLIANCE_GATES, LOOSENINGS, looseningOf, PRODUCT_TYPES, REQUIREMENT_KINDS } from '@nexus/factory-domain/compliance/requirements/rules'
import { PPE_CATEGORIES } from '@nexus/factory-domain/compliance/cert-gate/gate'
import { EVIDENCE_RULES, SETTING_SOURCES } from '@nexus/factory-domain/quality/lab/rules'
import { ApiError } from '../../../lib/api/errors'
import type { DesignScreen } from '../../../lib/design/design-screen'
import { LOCALES } from '../../../lib/i18n/locales'
import { CATALOGUE, messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { recordAddress } from '../../../lib/records/record-links'
import { permissionCheck } from '../../../lib/session/session'
import { OFFICE_PAGES, officeNavFor } from '../../../shell/nav/office-nav'
import { coverageState, documentsOf, shownLanguages } from '../_shared/language-matrix/model'
import { CERT_COVERAGE, DOC_LANGUAGE, gateMatrix, LABEL_LANGUAGE, MARKETS, REQUIREMENTS, TEXTILE_IT, TODAY } from './_demo/fixtures'
import { designScreen } from './fixtures'
import {
  addressOf,
  addressText,
  approveHeld,
  assessHeld,
  cellHeld,
  codesOf,
  crViHeld,
  crViLoosens,
  EMPTY_ADDRESS,
  EMPTY_MARKET,
  EMPTY_REQUIREMENT,
  emptyOperator,
  entryCellProblem,
  gateChanges,
  gateDraftOf,
  gateLoosenings,
  isLowerLimit,
  liveTabsOf,
  looseningsOf,
  marketBodyOf,
  marketHeld,
  marketListOf,
  missingSuggestions,
  operatorBodyOf,
  operatorHeld,
  OVERRIDE_ROLES,
  PROBLEM_FIELDS,
  problemOf,
  REFUSAL_CODES,
  requirementBodyOf,
  requirementHeld,
  rulesBodyOf,
  rulesCan,
  rulesHeld,
  SETTINGS_TABS,
  suggestionBody,
  SUGGESTIONS,
  switchesOff,
  switchHeld,
  tabOf,
  tabsFor,
  withAddress,
} from './model'

const params = (text: string) => new URLSearchParams(text)
const perms = (key: string) => [...(templateOf(key)?.permissions ?? [])]

describe('rules & markets: the address and who may do what', () => {
  it('keeps the tab, its filters and its dialogs in the address; another tab starts afresh', () => {
    const address = addressOf(params('tab=regulations&kind=HARMONISED_STANDARD&status=SUPERSEDED&q=17092&open=e1&watch=all'))
    expect(address).toMatchObject({ tab: 'regulations', kind: 'HARMONISED_STANDARD', status: 'SUPERSEDED', q: '17092', open: 'e1', watch: 'all', add: false })
    expect(addressOf(params(addressText(address).slice(1)))).toEqual(address)
    expect(addressOf(params('tab=nope&kind=X&status=Y&role=Z&market=italy&scope=x'))).toEqual(EMPTY_ADDRESS)
    expect(withAddress(address, { tab: 'markets' })).toEqual({ ...EMPTY_ADDRESS, tab: 'markets' })
    expect(withAddress({ ...address, scope: 'all' }, { tab: 'cr6' }).scope).toBe('all')
    expect(addressOf(params('tab=operators&role=IMPORTER&market=UK&add=1'))).toMatchObject({ role: 'IMPORTER', market: 'UK', add: true })
  })

  it('gives the page to every compliance reader, the Cr VI rule to the owner, the rules to the quality inspector', () => {
    const quality = rulesCan(perms('quality_inspector'))
    expect(quality).toMatchObject({ view: true, crViView: true, crViManage: false, rulesManage: true, phrasesManage: true, phrasesApprove: true, requirementsManage: true })
    expect(rulesCan(perms('owner')).crViManage).toBe(true)
    expect(rulesCan(perms('production_manager'))).toMatchObject({ view: true, rulesManage: false, requirementsManage: false, phrasesApprove: false })
    expect(tabsFor(quality)).toEqual([...SETTINGS_TABS])
    const readOnly = rulesCan(perms('read_only'))
    expect(tabOf(EMPTY_ADDRESS, readOnly)).toBe(readOnly.crViView ? 'cr6' : 'gates')
    expect(tabOf({ ...EMPTY_ADDRESS, tab: 'cr6' }, { ...quality, crViView: false })).toBe('gates')
    expect(tabOf(EMPTY_ADDRESS, rulesCan(perms('sales')))).toBeNull()
    const nav = officeNavFor(permissionCheck([...perms('quality_inspector'), 'home.view']))
    const compliance = nav.areas.find((area) => area.id === 'compliance')!
    expect((compliance.sections ?? []).flatMap((section) => section.items.map((item) => item.href))).toContain('/compliance/settings')
    expect(OFFICE_PAGES.has('/compliance/settings')).toBe(true)
    expect(recordAddress({ type: 'StandardChange', id: 'c1' }, OFFICE_PAGES)).toBe('/compliance/settings?tab=regulations&change=c1')
    expect(recordAddress({ type: 'EconomicOperatorRole', id: 'o1' }, OFFICE_PAGES)).toBe('/compliance/settings?tab=operators&open=o1')
  })

  it('reads the tab a live event touches again', () => {
    expect(liveTabsOf('quality.settings_changed')).toEqual(['cr6'])
    expect(liveTabsOf('compliance_gates.requirement_changed')).toEqual(['gates'])
    expect(liveTabsOf('compliance_rules.change_moved')).toEqual(['regulations'])
    expect(liveTabsOf('compliance_rules.translation_changed')).toEqual(['phrases', 'markets'])
    expect(liveTabsOf('compliance_gates.refused')).toEqual([])
  })
})

describe('rules & markets: Chromium VI and the gates', () => {
  it('says a looser Cr VI rule and holds Apply with why', () => {
    expect(crViLoosens('LOT_REPORT_REQUIRED', 'SUPPLIER_REPORT_ACCEPTED')).toBe(true)
    expect(crViLoosens('SUPPLIER_REPORT_ACCEPTED', 'LOT_REPORT_REQUIRED')).toBe(false)
    expect(crViHeld({ mayManage: false, changed: true, busy: false })).toBe('held.crViManage')
    expect(crViHeld({ mayManage: true, changed: false, busy: false })).toBe('held.nothingChanged')
    expect(crViHeld({ mayManage: true, changed: true, busy: false })).toBeNull()
    expect(isLowerLimit('1.5')).toBe(true)
    expect(isLowerLimit('3')).toBe(false)
    expect(isLowerLimit(null)).toBe(false)
  })

  it('names every loosening with the same codes as factory-domain, and only those', () => {
    const rows = gateMatrix().rows
    const label = rows.find((row) => row.requirement.code === LABEL_LANGUAGE.code)!
    const draft = { ...gateDraftOf(label), blocks: [], overrideRoleKeys: ['quality_inspector', 'owner'], overrideMaxDays: 5, switchedOn: false }
    const lines = gateLoosenings(label, draft)
    expect(lines.map((line) => line.code)).toEqual(['BLOCK_REMOVED', 'OVERRIDE_ROLE_ADDED', 'OVERRIDE_LONGER', 'SWITCHED_OFF'])
    expect(lines[0]!.params).toEqual({ gate: 'LABEL_PRINT' })
    expect(lines[1]!.params).toEqual({ role: 'owner' })
    expect(new Set(lines.map((line) => line.code))).toEqual(new Set(looseningOf({ ...label.requirement }, { ...label.requirement, blocks: [], overrideRoleKeys: ['quality_inspector', 'owner'], overrideMaxDays: 5, switchedOn: false }).map((entry) => entry.code)))
    // Tightening: a gate more, a role less, fewer days, switched on: nothing to confirm.
    const doc = rows.find((row) => row.requirement.code === DOC_LANGUAGE.code)!
    expect(gateLoosenings(doc, { ...gateDraftOf(doc), blocks: ['SHIPMENT', 'LABEL_PRINT'], overrideRoleKeys: [], overrideMaxDays: 2 })).toEqual([])
    const textile = rows.find((row) => row.requirement.code === TEXTILE_IT.code)!
    expect(gateLoosenings(textile, { ...gateDraftOf(textile), switchedOn: true })).toEqual([])
    const drafts = { [label.requirement.code]: draft, [textile.requirement.code]: { ...gateDraftOf(textile), switchedOn: true } }
    expect(gateChanges(rows, drafts)).toBe(2)
    expect(looseningsOf(rows, drafts).map((entry) => entry.code)).toEqual([label.requirement.code])
    expect(switchesOff(rows, drafts)).toEqual([label.requirement.code])
    expect(LOOSENINGS).toContain('BLOCK_REMOVED')
  })

  it('holds the law’s padlocks and the built-in row, in words', () => {
    const rows = gateMatrix().rows
    const cert = rows.find((row) => row.requirement.code === CERT_COVERAGE.code)!
    expect(cellHeld(cert, 'SHIPMENT')).toBe('held.locked')
    expect(cellHeld(cert, 'WORK_ORDER_RELEASE')).toBeNull()
    expect(switchHeld(cert)).toBe('held.lockedOn')
    const readOnly = gateMatrix(false).rows.find((row) => row.requirement.code === DOC_LANGUAGE.code)!
    expect(cellHeld(readOnly, 'SHIPMENT')).toBe('held.requirementsManage')
    expect(cellHeld({ ...cert, requirement: { ...cert.requirement, lockedBlocks: [], builtIn: true }, mayLoosen: false }, 'SHIPMENT')).toBe('held.builtIn')
  })

  it('offers the rows the plugged checks wait for, OFF with the reason; the person’s own row is checked first', () => {
    const missing = missingSuggestions(REQUIREMENTS)
    expect(missing.map((entry) => entry.checkKey)).toEqual(['label.ceMarking', 'label.classWarnings', 'label.gloveMarking', 'label.qrCode', 'label.artwork', 'label.reconciliation', 'claims.evidence'])
    expect(missingSuggestions([...REQUIREMENTS, { code: 'X', checkKey: 'claims.evidence' }]).some((entry) => entry.checkKey === 'claims.evidence')).toBe(false)
    expect(missingSuggestions([{ code: 'CLAIM-EVIDENCE', checkKey: null }]).some((entry) => entry.code === 'CLAIM-EVIDENCE')).toBe(false)
    for (const entry of SUGGESTIONS) {
      const body = suggestionBody(entry, '  Waits for the Owner  ', 'it')
      expect(body).toMatchObject({ switchedOn: false, offReason: 'Waits for the Owner', checkKey: entry.checkKey, nameI18n: { it: entry.name.it, en: entry.name.en } })
      expect(body.legalReference.length).toBeGreaterThan(3)
      expect(body.blocks.length).toBe(1)
    }
    expect(requirementHeld(EMPTY_REQUIREMENT)).toBe('held.code')
    const own = { ...EMPTY_REQUIREMENT, code: 'USER-INFO-DE', nameEn: 'German user information', kind: 'USER_INFO_LANGUAGE' as const, legalReference: 'Reg. (EU) 2016/425 art. 8(7)' }
    expect(requirementHeld(own)).toBe('held.reason')
    expect(requirementHeld({ ...own, switchedOn: true })).toBeNull()
    expect(requirementHeld({ ...own, kind: 'OPERATOR_ROLE', switchedOn: true })).toBe('held.operatorRole')
    expect(requirementBodyOf({ ...own, switchedOn: true }, 'it')).toMatchObject({ name: 'German user information', nameI18n: { en: 'German user information' }, offReason: null, checkKey: null })
    expect(OVERRIDE_ROLES).toContain('quality_inspector')
  })
})

describe('rules & markets: register, markets, phrases and operators', () => {
  it('checks a typed cell before the API is asked', () => {
    expect(entryCellProblem('link', 'http://example.com')).toBe('held.link')
    expect(entryCellProblem('link', '')).toBeNull()
    expect(entryCellProblem('title', ' ')).toBe('held.title')
    expect(codesOf('de, FR it de')).toEqual(['de', 'fr', 'it'])
    expect(marketListOf('markings', 'ce ukca')).toEqual({ codes: ['CE', 'UKCA'], problem: null })
    expect(marketListOf('labelLanguages', 'deutsch').problem).toBe('held.languages')
    expect(assessHeld({ impact: 'NONE', assessment: 'Fine', reviewCertificateIds: ['c1'] })).toBe('held.noReviewForNone')
    expect(assessHeld({ impact: 'RETEST', assessment: 'Fine', reviewCertificateIds: [] })).toBe('held.reviewCertificates')
    expect(assessHeld({ impact: 'REVIEW', assessment: 'Fine', reviewCertificateIds: ['c1'] })).toBeNull()
  })

  it('builds a market and its national rules as the API takes them', () => {
    expect(marketHeld(EMPTY_MARKET)).toBe('held.marketCode')
    const nl = { ...EMPTY_MARKET, code: 'nl', name: 'Netherlands', labelLanguages: 'nl, en', switchedOn: false }
    expect(marketHeld(nl)).toBe('held.reason')
    expect(marketBodyOf({ ...nl, offReason: 'Not yet' })).toMatchObject({ code: 'NL', labelLanguages: ['nl', 'en'], markings: ['CE'], offReason: 'Not yet', switchedOn: false })
    expect(rulesHeld([{ key: 'fr pfas', it: 'x', en: '', law: '', href: '' }])).toBe('held.ruleKey')
    expect(rulesHeld([{ key: 'fr-pfas', it: '', en: '', law: '', href: '' }])).toBe('held.ruleWords')
    expect(rulesBodyOf([{ key: 'fr-pfas', it: 'Regola', en: '', law: ' ', href: '' }])).toEqual([{ key: 'fr-pfas', words: { it: 'Regola' } }])
    expect(MARKETS.filter((market) => !market.switchedOn).map((market) => market.code)).toEqual(['UK', 'CH'])
  })

  it('never lets the author approve their own words', () => {
    expect(approveHeld({ mayApprove: true, draftBy: 'me', me: 'me', busy: false })).toBe('held.ownWords')
    expect(approveHeld({ mayApprove: false, draftBy: 'other', me: 'me', busy: false })).toBe('held.phrasesApprove')
    expect(approveHeld({ mayApprove: true, draftBy: 'other', me: 'me', busy: false })).toBeNull()
  })

  it('builds an operator row: scope, party (our company only for a maker), days', () => {
    const draft = emptyOperator(TODAY)
    expect(operatorHeld(draft)).toBe('held.role')
    expect(operatorHeld({ ...draft, role: 'IMPORTER', printedName: 'X', printedAddress: 'Y' })).toBe('held.partyId')
    expect(operatorHeld({ ...draft, role: 'MANUFACTURER', scope: 'STYLE', printedName: 'X', printedAddress: 'Y' })).toBe('held.styleId')
    expect(operatorHeld({ ...draft, role: 'MANUFACTURER', printedName: 'X', printedAddress: 'Y', validTo: '2020-01-01' })).toBe('held.validTo')
    expect(operatorBodyOf({ ...draft, role: 'MANUFACTURER', scope: 'TENANT', printedName: ' X ', printedAddress: 'Y' }, 'c1')).toMatchObject({ companyId: null, styleId: null, brandPartyId: null, partyId: null, printedName: 'X', contact: null })
    expect(operatorBodyOf({ ...draft, role: 'MANUFACTURER', scope: 'BRAND', brandPartyId: 'b1', printedName: 'X', printedAddress: 'Y' }, 'c1')).toMatchObject({ companyId: 'c1', brandPartyId: 'b1' })
  })

  it('says a refusal in our words, with the field only when it has words', () => {
    const conflict = new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: 'body/blocks', message: 'The law locks it.' }])
    expect(problemOf(conflict)).toEqual({ key: 'problem.locked', field: 'blocks' })
    const bare = new ApiError('conflict', 409, 'conflict', 'There is a requirement X already.')
    expect(problemOf(bare, 'create').key).toBe('problem.taken')
    expect(problemOf(bare, 'overlap').key).toBe('problem.overlap')
    expect(problemOf(bare, 'delete').key).toBe('held.entryNamed')
    expect(problemOf(bare).key).toBe('problem.conflict')
    expect(problemOf(new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: 'version', message: '2' }]), 'create').key).toBe('problem.conflict')
    expect(problemOf(new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: 'refusal/OWN_PROPOSAL', message: 'x' }])).key).toBe('refusal.OWN_PROPOSAL')
    expect(problemOf(new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: 'refusal/SOMETHING_NEW', message: 'x' }])).key).toBe('problem.conflict')
    expect(problemOf(new ApiError('invalid', 400, 'validation_failed', 'x', null, [{ path: 'body/offReason', message: 'Say why.' }]))).toEqual({ key: 'problem.field', field: 'offReason' })
    expect(problemOf(new ApiError('invalid', 400, 'validation_failed', 'x', null, [{ path: 'body/unknownField', message: '?' }]))).toEqual({ key: 'problem.invalid', field: null })
    expect(problemOf(new Error('x')).key).toBe('problem.unavailable')
  })

  it('LanguageMatrix: the documents per market and language, and the coverage state', () => {
    const ch = { code: 'CH', name: 'Switzerland', switchedOn: false, needs: [{ language: 'de', documents: ['DOC', 'LABEL'] as ('DOC' | 'LABEL' | 'USER_INFO')[] }] }
    expect(documentsOf(ch, 'de')).toEqual(['LABEL', 'DOC'])
    expect(documentsOf(ch, 'fr')).toEqual([])
    expect(shownLanguages({ languages: ['de', 'fr'], markets: [ch] }, true)).toEqual([])
    expect(coverageState({ language: 'de', inLibrary: 4, ready: 4, proposed: 0, stale: 0, missing: 0 })).toBe('complete')
    expect(coverageState({ language: 'de', inLibrary: 4, ready: 3, proposed: 1, stale: 0, missing: 0 })).toBe('partial')
    expect(coverageState({ language: 'de', inLibrary: 4, ready: 2, proposed: 0, stale: 1, missing: 1 })).toBe('missing')
    expect(coverageState(undefined)).toBe('none')
  })
})

// ---- the words and every design case ---------------------------------------------------------------------------------------

const NAMESPACE = 'compliance-settings'
const TOP = [...new Set(Object.keys(CATALOGUE.en[NAMESPACE] ?? {}).map((key) => key.split('.')[0]!.replace(/_(one|other)$/, '')))]
const LEFT_KEY = new RegExp(`\\b(?:${TOP.join('|')})\\.[a-zA-Z_-]+(?:\\.[a-zA-Z_-]+)*\\b`)
const LEFT_PLACEHOLDER = /\{[a-zA-Z]+\}/
/** Said on purpose: permission names, check keys, phrase keys, e-mail addresses and links. */
const SAID = /\b(?:compliance\.[a-zA-Z.]+|quality\.[a-zA-Z.]+|product\.[a-zA-Z.]+|parties\.view|(?:certificate|doc|userInfo|label|operator|gpsr|claims|textile)\.[a-zA-Z]+|(?:warning|care|marking)\.[a-z-]+|[a-z.-]+@example\.com|https:\/\/[^\s"<]+)/g

function render(screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell', 'lists', 'records', 'quality']) }, createElement(View, { model })))
}

describe('rules & markets: the words', () => {
  it('every key in it and en; every word the screens name exists; every code has its words', () => {
    expect(Object.keys(CATALOGUE.it[NAMESPACE] ?? {}).sort()).toEqual(Object.keys(CATALOGUE.en[NAMESPACE] ?? {}).sort())
    const folder = fileURLToPath(new URL('.', import.meta.url))
    const files = readdirSync(folder, { recursive: true, withFileTypes: false }) as string[]
    const source = files.filter((file) => /\.tsx?$/.test(file) && !file.includes('.vitest.') && !file.includes('fixtures')).map((file) => readFileSync(join(folder, file), 'utf8')).join('\n')
    const literal = [...source.matchAll(/\bt\('([a-zA-Z0-9_.]+)'/g)].map((match) => match[1]!)
    const named = [...[...source.matchAll(/'((?:held|problem|saved|notice|loosen|refusal)\.[a-zA-Z0-9_.]+)'/g)].map((match) => match[1]!), 'stepUp.loosen']
    for (const locale of LOCALES) {
      const words = CATALOGUE[locale][NAMESPACE] ?? {}
      const has = (key: string) => key in words || `${key}_one` in words
      expect([...new Set([...literal, ...named])].filter((key) => !has(key)), locale).toEqual([])
      const codes: [string, readonly string[]][] = [
        ['gate', COMPLIANCE_GATES],
        ['kind', REQUIREMENT_KINDS],
        ['category', PPE_CATEGORIES],
        ['productType', PRODUCT_TYPES],
        ['operatorRole', OPERATOR_ROLES],
        ['level', SCOPE_LEVELS],
        ['levelWhat', SCOPE_LEVELS],
        ['regKind', REGULATION_KINDS],
        ['regStatus', REGULATION_STATUSES],
        ['changeKind', CHANGE_KINDS],
        ['changeStatus', CHANGE_STATUSES],
        ['impact', IMPACTS],
        ['impactHint', IMPACTS],
        ['transition', ['NONE', 'RUNNING', 'ENDS_SOON', 'ENDED']],
        ['phraseKind', PHRASE_KINDS],
        ['cell', CELL_STATES],
        ['translationStatus', TRANSLATION_STATUSES],
        ['cr6.option', EVIDENCE_RULES],
        ['cr6.hint', EVIDENCE_RULES],
        ['cr6.short', EVIDENCE_RULES],
        ['cr6.source', SETTING_SOURCES],
        ['loosen.code', LOOSENINGS],
        ['role', OVERRIDE_ROLES],
        ['field', PROBLEM_FIELDS],
        ['refusal', REFUSAL_CODES],
        ['tabs', SETTINGS_TABS],
        ['live', ['connecting', 'live', 'offline']],
      ]
      for (const [prefix, list] of codes) for (const code of list) expect(has(`${prefix}.${code}`), `${locale} ${prefix}.${code}`).toBe(true)
    }
  })

  it(`SCR-262: ${designScreen.cases.length} cases × it, en with no key or placeholder left`, () => {
    for (const entry of designScreen.cases) {
      for (const locale of LOCALES) {
        const html = render(designScreen as unknown as DesignScreen<unknown>, entry.model, locale).replace(SAID, '')
        expect(html.length, `SCR-262/${entry.id}`).toBeGreaterThan(200)
        expect(html.match(LEFT_KEY)?.[0] ?? null, `SCR-262/${entry.id} (${locale})`).toBeNull()
        expect(html.match(LEFT_PLACEHOLDER)?.[0] ?? null, `SCR-262/${entry.id} (${locale}) placeholder`).toBeNull()
      }
    }
  })

  it('SCR-262 names every state and role case the design asks for', () => {
    expect(designScreen.cases.map((entry) => entry.id)).toEqual(
      expect.arrayContaining(['normal', 'cr6-loosen', 'cr6-step-up', 'cr6-loading', 'cr6-error', 'gates', 'gates-loosen', 'gates-add', 'gates-read-only', 'regulations', 'regulations-change', 'markets', 'phrases', 'phrases-own-words', 'operators', 'no-permission', 'offline', 'keys']),
    )
  })
})
