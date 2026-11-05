import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { H1_SETTINGS } from '@nexus/factory-domain/plant/requests/lock'
import { ruleProblems } from '@nexus/factory-domain/plant/requests/routing'
import { checkTypeProblems, LEAST_RETENTION_YEARS } from '@nexus/factory-domain/plant/statutory/rules'
import { INAIL_RULE } from '@nexus/factory-domain/safety/incidents/rules'
import { createApiClient, type ApiClient } from '../../../lib/api/client'
import { ApiError } from '../../../lib/api/errors'
import type { DesignScreen } from '../../../lib/design/design-screen'
import { LOCALES } from '../../../lib/i18n/locales'
import { CATALOGUE, messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { RECORD_PAGES, LIST_PAGES } from '../../../lib/records/record-links'
import { OFFICE_PAGES } from '../../../shell/nav/office-nav'
import { addRule, changeRule, createCheckType, orderRules, readHistory, removeRule, saveLock, updateCheckType, type CheckType, type RoutingRule } from './depth-api'
import { DEMO_INCIDENT_RULES, DEMO_LOCK, DEMO_RULES, DEMO_TYPES } from './_demo/fixtures'
import {
  blankRule,
  blankType,
  DEPTH_FIELDS,
  DEPTH_SETTINGS_REFUSALS,
  depthProblemOf,
  depthReadProblem,
  draftExample,
  exampleOf,
  HISTORY_ACTIONS,
  historyWords,
  lockBody,
  lockChangeCount,
  lockDraftOf,
  lockHeld,
  lockLoosens,
  orderBody,
  removeOutcome,
  ruleAddBody,
  ruleChanges,
  ruleDraftOf,
  ruleExample,
  ruleFieldsOf,
  ruleHeld,
  ruleMoveHeld,
  ruleOrderAfter,
  ruleSwitchHeld,
  typeChanges,
  typeCreateBody,
  typeDraftOf,
  typeHeld,
  typeStateHeld,
  visibleTypes,
  type RuleDraft,
  type TypeDraft,
} from './depth-model'
import { designScreen as auditScreen } from './history/fixtures'
import { designScreen } from './fixtures'

const refusal = (status: number, kind: ApiError['kind'], issues: Array<{ path: string; message?: string }> = [], message = 'x') => new ApiError(kind, status, 'x', message, null, issues)
const words = (locale: (typeof LOCALES)[number]) => CATALOGUE[locale]['plant-settings'] ?? {}
const has = (locale: (typeof LOCALES)[number], key: string) => key in words(locale) || `${key}_one` in words(locale)

describe('Plant settings › Request routing and escalation (B-W2b-141): the rules', () => {
  it('holds Save rule exactly where factory-domain ruleProblems refuses it', () => {
    const team = { ...blankRule(), teamId: 'team-1', targetName: 'L1' }
    const drafts: RuleDraft[] = [
      blankRule(),
      team,
      { ...team, targetKind: 'TECHNICIAN' },
      { ...team, escalate: true },
      { ...team, escalate: true, escalateToId: 'p1' },
      { ...team, escalate: true, escalateToId: 'p1', escalateAfterMinutes: 0 },
      { ...team, escalate: true, escalateToId: 'p1', escalateAfterMinutes: 1441 },
      { ...team, escalate: true, escalateToId: 'p1', again: true },
      { ...team, escalate: true, escalateToId: 'p1', again: true, escalateAgainToId: 'p2' },
      { ...team, escalate: true, escalateToId: 'p1', again: true, escalateAgainToId: 'p2', escalateAgainAfterMinutes: 10 },
      { ...team, escalate: false, again: true, escalateAgainToId: 'p2' },
    ]
    for (const draft of drafts) {
      const fields = ruleFieldsOf(draft)
      expect(ruleHeld(draft, false) === null, JSON.stringify(fields)).toBe(ruleProblems(fields).length === 0)
    }
    expect(ruleHeld(blankRule(), false)).toBe('held.noTeam')
    expect(ruleHeld({ ...blankRule(), targetKind: 'TECHNICIAN' }, false)).toBe('held.noTechnician')
    expect(ruleHeld({ ...team, escalate: true }, false)).toBe('held.noEscalateTo')
    expect(ruleHeld({ ...team, escalate: true, escalateToId: 'p1', again: true, escalateAgainToId: 'p2', escalateAgainAfterMinutes: 10 }, false)).toBe('held.againLater')
    expect(ruleHeld(team, true)).toBe('held.busy')
  })

  it('sends a new rule whole and a change with only what differs (a target replaces the other; off sends null)', () => {
    const draft: RuleDraft = { ...blankRule('class-1'), teamId: 'team-1', escalate: true, escalateToId: 'p1', escalateAfterMinutes: 12 }
    expect(ruleAddBody('site-1', draft)).toEqual({ siteId: 'site-1', machineClassId: 'class-1', teamId: 'team-1', push: true, active: true, escalateAfterMinutes: 12, escalateToId: 'p1' })
    const rule = DEMO_RULES[0]!
    const same = ruleDraftOf(rule)
    expect(ruleChanges(rule, same)).toEqual({})
    expect(ruleChanges(rule, { ...same, targetKind: 'TECHNICIAN', technicianId: 'p9' })).toEqual({ technicianId: 'p9' })
    expect(ruleChanges(rule, { ...same, escalate: false })).toEqual({ escalateAfterMinutes: null, escalateToId: null, escalateAgainAfterMinutes: null, escalateAgainToId: null })
    expect(ruleChanges(rule, { ...same, again: false, push: false })).toEqual({ push: false, escalateAgainAfterMinutes: null, escalateAgainToId: null })
    expect(ruleChanges(rule, { ...same, machineClassId: null, active: false })).toEqual({ machineClassId: null, active: false })
  })

  it('says the worked example one fact per sentence, and the preview without a rule as the triage queue', () => {
    const lines = ruleExample(DEMO_RULES[0]!, 'Lineare', 'STAB-N')
    expect(lines.map((line) => line.key)).toEqual(['routing.example.goesClass.team', 'routing.example.push.team', 'routing.example.escalate', 'routing.example.again'])
    expect(lines[0]!.params).toEqual({ class: 'Lineare', site: 'STAB-N', target: 'L1 Squadra giacche' })
    expect(lines[2]!.params).toEqual({ minutes: 10, person: 'Marco Prova' })
    expect(ruleExample({ ...DEMO_RULES[3]!, push: null }, null, 'STAB-N').map((line) => line.key)).toEqual(['routing.example.goesAny.team', 'routing.example.escalate'])
    expect(exampleOf({ machineClass: null, site: 'S', target: null, push: true, escalate: null, again: null, active: true })).toEqual([{ key: 'routing.example.noneAny', params: { site: 'S' } }])
    expect(draftExample({ ...ruleDraftOf(DEMO_RULES[1]!), active: false }, 'Trancia', 'S').map((line) => line.key)).toEqual(['routing.example.off', 'routing.example.goesClass.person', 'routing.example.push.person', 'routing.example.escalate'])
    // A draft without a target yet: no rule fits (said, never a blank name).
    expect(draftExample(blankRule(), null, 'S')[0]!.key).toBe('routing.example.noneAny')
    for (const locale of LOCALES)
      for (const key of ['off', 'noneAny', 'noneClass', 'goesAny.team', 'goesAny.person', 'goesClass.team', 'goesClass.person', 'push.team', 'push.person', 'quiet.team', 'quiet.person', 'escalate', 'again', 'noEscalation']) expect(has(locale, `routing.example.${key}`), `${locale} ${key}`).toBe(true)
  })

  it('moves the chosen rules one place with the whole list at its versions; holds at the ends; switch and remove say what happens', () => {
    const rules = DEMO_RULES
    expect(ruleOrderAfter(rules, [rules[2]!.id], -1)).toEqual([rules[0]!.id, rules[2]!.id, rules[1]!.id, rules[3]!.id])
    expect(ruleOrderAfter(rules, [rules[0]!.id], -1)).toBeNull()
    expect(ruleMoveHeld(rules, [rules[3]!.id], 1, false)).toBe('held.atBottom')
    expect(ruleMoveHeld(rules, [rules[0]!.id], -1, false)).toBe('held.atTop')
    expect(ruleMoveHeld(rules, [rules[1]!.id], -1, true)).toBe('held.busy')
    expect(orderBody(rules, [rules[1]!.id, rules[0]!.id, rules[2]!.id, rules[3]!.id])).toEqual([
      { id: rules[1]!.id, version: 1 },
      { id: rules[0]!.id, version: 3 },
      { id: rules[2]!.id, version: 1 },
      { id: rules[3]!.id, version: 2 },
    ])
    expect(ruleSwitchHeld([rules[0]!], true, false)).toBe('held.allOn')
    expect(ruleSwitchHeld([rules[2]!], false, false)).toBe('held.allOff')
    expect(ruleSwitchHeld([rules[0]!, rules[2]!], true, false)).toBeNull()
    expect(removeOutcome([rules[0]!, rules[2]!, { ...rules[3]!, active: false }])).toEqual({ deleted: 1, switchedOff: 1, offAlready: 1 })
  })
})

describe('Plant settings › Unsafe lock: Owner answer H1 held, a loosening asks the code', () => {
  it('holds every choice but H1, counts the changes and sends the version read (null makes the row)', () => {
    const read = lockDraftOf(DEMO_LOCK)
    expect(read).toEqual(H1_SETTINGS)
    expect(lockHeld(read, false)).toBeNull()
    expect(lockHeld({ ...read, lockBy: 'LEADS_AND_TECHNICIANS' }, false)).toBe('held.h1Lock')
    expect(lockHeld({ ...read, signSafeBy: 'TECHNICIANS_AND_SAFETY_OFFICER' }, false)).toBe('held.h1SignSafe')
    expect(lockHeld(read, true)).toBe('held.busy')
    expect(lockLoosens(read, { ...read, hazardReportOnLock: false })).toBe(true)
    expect(lockLoosens({ ...read, hazardReportOnLock: false }, read)).toBe(false)
    expect(lockChangeCount(read, { ...read, hazardReportOnLock: false })).toBe(1)
    expect(lockBody('site-1', { version: null }, read)).toEqual({ siteId: 'site-1', version: null, lockBy: 'ANYONE_AT_STATION', signSafeBy: 'TECHNICIANS', hazardReportOnLock: true })
  })
})

describe('Plant settings › Statutory check types', () => {
  it('holds Add exactly where factory-domain checkTypeProblems refuses it; no interval is offered', () => {
    const blank = blankType(LEAST_RETENTION_YEARS)
    expect(blank.defaultInterval).toBeNull()
    expect(blank.retentionYears).toBe(LEAST_RETENTION_YEARS)
    const full: TypeDraft = { ...blank, code: 'NOISE', labelIt: 'Rumore', labelEn: 'Noise', legalBasis: 'D.Lgs. 81/2008 art. 71', defaultInterval: 6 }
    const drafts: TypeDraft[] = [full, { ...full, code: 'x1' }, { ...full, labelEn: ' ' }, { ...full, legalBasis: '' }, { ...full, defaultInterval: 0 }, { ...full, defaultInterval: 121 }, { ...full, defaultInterval: 11, defaultIntervalUnit: 'YEAR' }, { ...full, retentionYears: 2 }, { ...full, retentionYears: 31 }]
    for (const draft of drafts) expect(typeHeld(draft, [], LEAST_RETENTION_YEARS, false) === null, JSON.stringify(draft)).toBe(checkTypeProblems(typeCreateBody(draft), true).length === 0)
    expect(typeHeld(blank, [], LEAST_RETENTION_YEARS, false)).toBe('held.noCode')
    expect(typeHeld(full, ['NOISE'], LEAST_RETENTION_YEARS, false)).toBe('held.typeTaken')
    expect(typeHeld({ ...full, defaultInterval: null }, [], LEAST_RETENTION_YEARS, false)).toBe('held.noInterval')
    expect(typeCreateBody({ ...full, code: ' noise ', labelIt: ' Rumore ' })).toMatchObject({ code: 'NOISE', labelIt: 'Rumore', classId: null, outsideBody: false, retentionYears: LEAST_RETENTION_YEARS })
  })

  it('sends only what changed, filters and searches, and holds Retire / Make active again with reasons', () => {
    const type: CheckType = DEMO_TYPES[1]!
    const same = typeDraftOf(type)
    expect(typeChanges(type, same)).toEqual({})
    expect(typeChanges(type, { ...same, defaultInterval: 3, outsideBody: false, legalBasis: ' DPR 462/2001 ' })).toEqual({ defaultInterval: 3, outsideBody: false, legalBasis: 'DPR 462/2001' })
    expect(typeHeld(same, [type.code], LEAST_RETENTION_YEARS, false)).toBeNull()
    expect(visibleTypes(DEMO_TYPES, 'active', '').map((entry) => entry.code)).toEqual(['PRESS_GUARDS', 'EARTHING', 'COMPRESSOR_VESSEL'])
    expect(visibleTypes(DEMO_TYPES, 'retired', '').map((entry) => entry.code)).toEqual(['HEAT_PRESS_THERMO'])
    expect(visibleTypes(DEMO_TYPES, 'all', 'dpr').map((entry) => entry.code)).toEqual(['EARTHING'])
    expect(typeStateHeld([DEMO_TYPES[0]!], true, false)).toBe('held.allActive')
    expect(typeStateHeld([DEMO_TYPES[3]!], false, false)).toBe('held.allRetired')
    expect(typeStateHeld(DEMO_TYPES, false, true)).toBe('held.busy')
  })
})

describe("the API's refusals in this page's words", () => {
  it('a refusal by its code, a field at its field, else the kind; a lost answer is not known', () => {
    expect(depthProblemOf(refusal(409, 'conflict', [{ path: 'refusal/H1_HELD' }]))).toEqual({ key: 'refusal.H1_HELD', unknown: false })
    expect(depthProblemOf(refusal(409, 'conflict', [{ path: 'refusal/TYPE_TAKEN' }]))).toEqual({ key: 'refusal.TYPE_TAKEN', unknown: false, field: 'code' })
    expect(depthProblemOf(refusal(409, 'conflict', [{ path: 'refusal/SOMETHING_ELSE' }])).key).toBe('problem.refused')
    expect(depthProblemOf(refusal(409, 'conflict', [], 'A site has at most 100 routing rules.')).key).toBe('problem.tooManyRules')
    expect(depthProblemOf(refusal(409, 'conflict', [], 'The rule changed since you read it.')).key).toBe('problem.staleSettings')
    expect(depthProblemOf(refusal(400, 'invalid', [{ path: 'body/teamId' }]))).toEqual({ key: 'field.teamId', field: 'teamId', unknown: false })
    expect(depthProblemOf(refusal(400, 'invalid', [{ path: 'body/seq' }])).key).toBe('problem.invalid')
    expect(depthProblemOf(refusal(403, 'forbidden')).key).toBe('problem.forbiddenSettings')
    expect(depthProblemOf(refusal(0, 'unavailable'))).toEqual({ key: 'problem.offlineSettings', unknown: true })
    expect(depthProblemOf(new Error('boom'))).toEqual({ key: 'problem.failed', unknown: true })
    expect(depthReadProblem(refusal(403, 'forbidden'))).toBe('problem.readForbiddenSection')
    for (const locale of LOCALES) {
      for (const code of DEPTH_SETTINGS_REFUSALS) expect(has(locale, `refusal.${code}`), `${locale} ${code}`).toBe(true)
      for (const field of DEPTH_FIELDS) expect(has(locale, `field.${field}`), `${locale} ${field}`).toBe(true)
      for (const key of ['refused', 'tooManyRules', 'staleSettings', 'forbiddenSettings', 'stepUp', 'goneSettings', 'busyServer', 'offlineSettings', 'readForbiddenSection']) expect(has(locale, `problem.${key}`), `${locale} ${key}`).toBe(true)
      for (const key of ['wrong', 'locked', 'unavailable']) expect(has(locale, `stepUp.problem.${key}`), `${locale} ${key}`).toBe(true)
    }
  })

  it('says each audit row in words (what the row says it did), every action in both languages', () => {
    expect(historyWords({ action: 'plant.removeRoutingRule', after: { outcome: 'DELETED' } }).key).toBe('history.action.ruleDeleted')
    expect(historyWords({ action: 'plant.removeRoutingRule', after: { outcome: 'SWITCHED_OFF' } }).key).toBe('history.action.ruleSwitchedOff')
    expect(historyWords({ action: 'plant.setLockSettings', before: { hazardReportOnLock: true }, after: { hazardReportOnLock: false } }).key).toBe('history.action.hazardOff')
    expect(historyWords({ action: 'plant.updateCheckType', before: { code: 'X', active: true }, after: { code: 'X', active: false } })).toEqual({ key: 'history.action.typeRetired', params: { code: 'X' } })
    expect(historyWords({ action: 'plant.createCheckType', after: { code: 'X' } })).toEqual({ key: 'history.action.createCheckTypeCode', params: { code: 'X' } })
    expect(historyWords({ action: 'plant.reportIn' }).key).toBe('history.action.other')
    for (const locale of LOCALES) {
      for (const action of HISTORY_ACTIONS) for (const key of [action, `${action}Code`]) expect(has(locale, `history.action.${key}`), `${locale} ${key}`).toBe(true)
      for (const key of ['ruleDeleted', 'ruleSwitchedOff', 'ruleUnchanged', 'lockUnchanged', 'hazardOff', 'hazardOn', 'typeRetired', 'typeRestored', 'other']) expect(has(locale, `history.action.${key}`), `${locale} ${key}`).toBe(true)
    }
  })
})

describe('the calls and the place', () => {
  it('each write carries an Idempotency-Key, the CSRF token and the version read; the audit log reads each record type', async () => {
    const calls: { url: string; method: string; body: unknown; headers: Headers }[] = []
    const rule: RoutingRule = DEMO_RULES[0]!
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null, headers: new Headers(init?.headers) })
      const body = url.includes('/remove')
        ? { outcome: 'SWITCHED_OFF', rules: [rule], replayed: false }
        : url.includes('/plant/settings/routing')
          ? { rules: [rule], replayed: false }
          : url.includes('/plant/settings/lock')
            ? { ...DEMO_LOCK, replayed: false }
            : url.includes('/plant/checks/types')
              ? { type: DEMO_TYPES[0], replayed: false }
              : { entries: [], nextBefore: null, counts: null }
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    const api: ApiClient = createApiClient({ baseUrl: '/api', fetch: fetcher as unknown as typeof globalThis.fetch, company: 'DEMO', csrfToken: () => 'csrf-demo' })
    await addRule(api, { siteId: 's', teamId: 't' }, 'k1')
    await changeRule(api, rule.id, { version: 3, active: false }, 'k2')
    await removeRule(api, rule.id, 3, 'k3')
    await orderRules(api, 's', [{ id: rule.id, version: 3 }], 'k4')
    await saveLock(api, { siteId: 's', version: null, hazardReportOnLock: false }, 'k5')
    await createCheckType(api, { code: 'X1', classId: null, labelIt: 'a', labelEn: 'b', legalBasis: 'c', defaultInterval: 1, defaultIntervalUnit: 'YEAR', outsideBody: false, retentionYears: LEAST_RETENTION_YEARS }, 'k6')
    await updateCheckType(api, 'type-1', { version: 2, active: false }, 'k7')
    const writes = calls.splice(0)
    expect(writes.map((call) => `${call.method} ${call.url}`)).toEqual([
      'POST /api/plant/settings/routing',
      `PATCH /api/plant/settings/routing/${rule.id}`,
      `POST /api/plant/settings/routing/${rule.id}/remove`,
      'POST /api/plant/settings/routing/order',
      'PUT /api/plant/settings/lock',
      'POST /api/plant/checks/types',
      'PATCH /api/plant/checks/types/type-1',
    ])
    expect(writes[1]!.body).toEqual({ version: 3, active: false })
    expect(writes[4]!.body).toEqual({ siteId: 's', version: null, hazardReportOnLock: false })
    for (const call of writes) {
      expect(call.headers.get('idempotency-key'), call.url).toBeTruthy()
      expect(call.headers.get('x-csrf-token'), call.url).toBe('csrf-demo')
    }
    await readHistory(api)
    expect(calls.map((call) => call.url)).toEqual([
      '/api/audit?recordType=RequestRoutingRule&limit=100',
      '/api/audit?recordType=PlantSettings&limit=100',
      '/api/audit?recordType=MachineCheckType&limit=100',
      '/api/audit?recordType=MachineSymptom&limit=100',
      '/api/audit?recordType=MachineClass&limit=100',
      '/api/audit?action=plant.orderRoutingRules&limit=100',
    ])
  })

  it('the audit log is a built page; a rule and a check type open in their dialog; the incident rules are the law\'s as the API says them', () => {
    expect(OFFICE_PAGES.has('/plant/settings/history')).toBe(true)
    expect(RECORD_PAGES.RequestRoutingRule).toBe('/plant/settings?rule=[id]')
    expect(RECORD_PAGES.MachineCheckType).toBe('/plant/settings?type=[id]')
    expect(LIST_PAGES['/plant/checks/types']).toBe('/plant/settings')
    expect(DEMO_INCIDENT_RULES.rule).toMatchObject(INAIL_RULE)
  })
})

// ---- every design case of SCR-241-audit (SCR-241's own are in settings.vitest) -------------------------------------------------

const TOP = [...new Set(Object.keys(CATALOGUE.en['plant-settings'] ?? {}).map((key) => key.split('.')[0]!.replace(/_(one|other)$/, '')))]
const LEFT_KEY = new RegExp(`\\b(?:${TOP.join('|')})\\.[a-zA-Z_-]+(?:\\.[a-zA-Z_-]+)*\\b`)
const SAID = /\b(?:plant|safety|people|audit)\.[a-zA-Z.]+/g

function render(screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell', 'lists', 'records']) }, createElement(View, { model })))
}

describe('SCR-241-audit and the W2b cases of SCR-241', () => {
  it(`SCR-241-audit: ${auditScreen.cases.length} cases × it, en with no key or placeholder left`, () => {
    for (const item of auditScreen.cases) {
      for (const locale of LOCALES) {
        const html = render(auditScreen as unknown as DesignScreen<unknown>, item.model, locale).replace(SAID, '')
        expect(html.length, item.id).toBeGreaterThan(200)
        expect(html.match(LEFT_KEY)?.[0] ?? null, `${item.id} (${locale})`).toBeNull()
        expect(html.match(/\{[a-zA-Z]+\}/)?.[0] ?? null, `${item.id} (${locale}) placeholder`).toBeNull()
      }
    }
  })

  it('SCR-241 holds a case for every W2b section, state and role the design names', () => {
    expect(designScreen.cases.map((entry) => entry.id)).toEqual(
      expect.arrayContaining(['routing', 'routing-selected', 'routing-empty', 'routing-loading', 'routing-error', 'preview-none', 'rule-new', 'rule-edit', 'rule-held', 'rule-no-people', 'rule-refused', 'rule-remove', 'rules-remove', 'rule-read-only', 'lock-h1', 'lock-hazard-off', 'lock-step-up', 'lock-step-up-wrong', 'lock-refused', 'lock-defaults', 'checks-new', 'checks-edit', 'checks-taken', 'checks-retired', 'checks-selected', 'checks-retire', 'checks-read-only', 'checks-error', 'incidents', 'incidents-no-right', 'all-sites', 'changed-settings', 'leave', 'page-keys', 'no-audit']),
    )
    // The W2b words of a case are the page's: an INAIL number on screen is the API's, never one of ours.
    const html = render(designScreen as unknown as DesignScreen<unknown>, designScreen.cases.find((entry) => entry.id === 'incidents')!.model, 'en')
    expect(html).toContain(`Within ${INAIL_RULE.hoursAfterCertificate} hours of receiving the medical certificate`)
    expect(html).toContain(`More than ${INAIL_RULE.insuranceAboveDays} days of absence`)
  })
})
