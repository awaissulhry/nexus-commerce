import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ERASURE_BLOCKED, KEPT_WHY } from '@nexus/factory-domain/privacy/retention/erasure'
import { DATA_REQUEST_KINDS, DATA_REQUEST_STATUSES, DATA_SUBJECT_KINDS, REQUEST_HELD } from '@nexus/factory-domain/privacy/retention/requests'
import { APPEND_ONLY_LEDGERS, DATED_PURGES, ERASURE_METHODS, KEPT_FOR_GOOD, RETENTION_ACTIONS, RULE_HELD, SWEEP_FAILURES, SWEEP_HELD, SWEEP_MODES, SWEEP_STATUSES } from '@nexus/factory-domain/privacy/retention/retention'
import { ApiError } from '../../../../lib/api/errors'
import type { DesignScreen } from '../../../../lib/design/design-screen'
import { LOCALES } from '../../../../lib/i18n/locales'
import { messagesFor } from '../../../../lib/i18n/messages'
import { I18nProvider } from '../../../../lib/i18n/provider'
import { designScreen as eraseScreen } from '../erase/fixtures'
import { ERASURE_FIELDS, ERASURE_TYPES, eraseHeld, fieldKeys, sectionsOf, typeKey as eraseTypeKey, type EraseModel } from '../erase/model'
import { privacyCan, viewOf, viewsFor } from '../model'
import { designScreen as retentionScreen } from '../retention/fixtures'
import { bulkSweepable, changeAsksCode, draftOfRule, KEPT_KEYS, lastSweepPhrase, periodParts, PURGE_KEYS, RETENTION_TYPE_NAMES, retentionCan, ruleDraftHeld, ruleHeld, rulePatch, typeKey } from '../retention/model'
import { REQUEST_VIEWS } from './api'
import { depthDutyLines } from './DepthDuties'
import { DEMO_REQUESTS, designScreen, NOW } from './fixtures'
import { Clock } from './view/Clock'
import { actionHeld, clockTone, emptyDraft, formHeld, isDepthEvent, newRequestHeld, problemOf, requestsAddressOf, requestsCan, requestsCsv, withRequestsAddress } from './model'

/**
 * B-W2b-414 data protection on screen: the requests' clock, held steps and CSV (never a name), New data request's checks, the
 * erasure's held order and words, the retention rules' held steps, form and fresh-code rule, the duty lines, every key the code
 * names in both languages (from the domain's own code lists, so a new code fails here), and SCR-660, -661, -662 drawn in it
 * and en with no key on screen.
 */

const ADMIN = requestsCan(['privacy.requests.view', 'privacy.requests.manage', 'privacy.erase', 'parties.view', 'users.view'])
const READER = requestsCan(['privacy.requests.view'])
const { LATE_ERASURE, SOON_ACCESS, READY, ERASED_DONE, EXTENDED } = DEMO_REQUESTS

describe('data requests', () => {
  it('the clock: late, soon (3 days or less), in time, closed', () => {
    expect(clockTone(LATE_ERASURE)).toBe('late')
    expect(clockTone(SOON_ACCESS)).toBe('soon')
    expect(clockTone(EXTENDED)).toBe('ok')
    expect(clockTone(ERASED_DONE)).toBe('closed')
  })

  it('a held step says the right first, then the request\'s own code', () => {
    expect(actionHeld(SOON_ACCESS, 'collect', ADMIN)).toBe('dp.held.NOT_STARTED')
    expect(actionHeld(READY, 'close', ADMIN)).toBeNull()
    expect(actionHeld(READY, 'close', READER)).toBe('dp.req.held.manage')
    expect(actionHeld(LATE_ERASURE, 'erase', READER)).toBe('dp.req.held.erase')
    expect(actionHeld(LATE_ERASURE, 'extend', ADMIN)).toBe('dp.held.TOO_LATE_TO_EXTEND')
    expect(actionHeld(EXTENDED, 'extend', ADMIN)).toBe('dp.held.EXTENDED')
  })

  it('the CSV for an auditor has the clock and the outcome, never a name', () => {
    const csv = requestsCsv([LATE_ERASURE, READY])
    expect(csv.split('\n')[0]).toBe('company;kind;personKind;personRecord;received;due;extended;status;late;identityChecked;decided')
    expect(csv).not.toContain('Bruno Prova')
    expect(csv).not.toContain('Dario Esempio')
    expect(csv).toContain(`Inquiry:${LATE_ERASURE.person.recordId}`)
  })

  it('the address keeps the page\'s terms and drops the defaults', () => {
    expect(requestsAddressOf(new URLSearchParams('view=requests&requests=all&kind=ERASURE&request=r1&new=1'))).toEqual({ view: 'all', kind: 'ERASURE', request: 'r1', creating: true })
    expect(requestsAddressOf(new URLSearchParams('requests=nope&kind=X'))).toEqual({ view: 'open', kind: null, request: null, creating: false })
    expect(withRequestsAddress('company=c1&view=notices', { view: 'open', request: 'r2' })).toBe('company=c1&view=requests&request=r2')
    expect(withRequestsAddress('view=requests&new=1&requests=closed', { creating: false, view: 'open' })).toBe('view=requests')
  })

  it('New data request: the right, the company, the person of that company, a time not in the future', () => {
    const now = '2026-11-15T09:00:00.000Z'
    const draft = emptyDraft('c1', now)
    expect(newRequestHeld(draft, READER, now)).toBe('dp.req.held.manage')
    expect(newRequestHeld({ ...draft, companyId: '' }, ADMIN, now)).toBe('dp.new.held.company')
    expect(newRequestHeld(draft, ADMIN, now)).toBe('dp.new.held.person')
    const person = { recordType: 'PartyContact', recordId: 'p1', label: 'Anna Esempio', companyId: 'c2' }
    expect(newRequestHeld({ ...draft, person }, ADMIN, now)).toBe('dp.new.held.otherCompany')
    expect(newRequestHeld({ ...draft, person: { ...person, companyId: null }, receivedAt: '2026-11-15T09:30:00.000Z' }, ADMIN, now)).toBe('dp.new.held.future')
    expect(newRequestHeld({ ...draft, person: { ...person, companyId: 'c1' } }, ADMIN, now)).toBeNull()
  })

  it('a form needs its words (withdrawn needs none)', () => {
    expect(formHeld({ name: 'identity', how: 'x' })).toBe('dp.form.how')
    expect(formHeld({ name: 'refuse', reason: '' })).toBe('dp.form.reason')
    expect(formHeld({ name: 'withdraw', reason: '' })).toBeNull()
    expect(formHeld({ name: 'extend', months: 1, reason: 'Many orders' })).toBeNull()
  })

  it('a blocked erasure is said by its code; other problems by kind, never the API\'s English', () => {
    expect(problemOf(new ApiError('conflict', 409, 'conflict', 'English', null, [{ path: 'privacy/PORTAL_USER', message: 'English' }]))).toBe('dp.erase.blocked.PORTAL_USER')
    expect(problemOf(new ApiError('conflict', 409, 'invalid_state', 'English'))).toBe('dp.problem.conflict')
    expect(problemOf(new ApiError('unavailable', 0, 'network', 'English'))).toBe('dp.problem.unavailable')
    expect(problemOf(new Error('x'))).toBe('dp.problem.failed')
  })

  it('the page\'s lists: Data requests only with privacy.requests.view; the depth events are the sections\' own', () => {
    expect(viewsFor(privacyCan(['privacy.view']))).toEqual(['notices', 'dpia', 'register', 'retention'])
    expect(viewsFor(privacyCan(['privacy.view', 'privacy.requests.view']))).toEqual(['notices', 'dpia', 'register', 'requests', 'retention'])
    expect(viewOf('retention')).toBe('retention')
    expect(isDepthEvent('privacy.request_changed')).toBe(true)
    expect(isDepthEvent('privacy.notice_published')).toBe(false)
  })

  it('the duty lines: late first, then open; no rule is to do, all reporting is to watch', () => {
    expect(depthDutyLines({ requests: { open: 3, late: 1 }, retention: null })).toEqual([{ key: 'requests', view: 'requests', state: 'needs', words: { key: 'dp.duty.requests.late', params: { count: 1 } } }])
    expect(depthDutyLines({ requests: { open: 0, late: 0 }, retention: { rules: 0, applying: 0 } }).map((line) => line.state)).toEqual(['done', 'needs'])
    expect(depthDutyLines({ requests: null, retention: { rules: 4, applying: 0 } })[0]!.state).toBe('review')
    expect(depthDutyLines({ requests: null, retention: { rules: 4, applying: 1 } })[0]!.state).toBe('done')
  })
})

describe('Anonymise …?', () => {
  const preview = eraseScreen.cases.find((item) => item.id === 'prospect')!.model.model.erase!.preview.value!
  const model = (extra: Partial<EraseModel>): EraseModel => ({ requestId: 'r1', version: 1, preview: { value: preview, problem: null }, reason: '', typed: '', busy: false, problem: null, done: null, ...extra })
  it('held in order: the right, the preview, a block, nothing to erase, the reason, the exact name', () => {
    expect(eraseHeld(model({}), false)).toBe('dp.req.held.erase')
    expect(eraseHeld(model({ preview: { value: null, problem: null } }), true)).toBe('dp.erase.held.loading')
    expect(eraseHeld(model({ preview: { value: { ...preview, blocked: { code: 'STILL_ACTIVE' } }, problem: null } }), true)).toBe('dp.erase.blocked.STILL_ACTIVE')
    expect(eraseHeld(model({ preview: { value: { ...preview, anonymised: [], deleted: [] }, problem: null } }), true)).toBe('dp.erase.held.nothing')
    expect(eraseHeld(model({ reason: 'ok' }), true)).toBe('dp.erase.held.reason')
    expect(eraseHeld(model({ reason: 'Asked by mail', typed: 'bruno prova' }), true)).toBe('dp.erase.held.typed')
    expect(eraseHeld(model({ reason: 'Asked by mail', typed: 'Bruno Prova' }), true)).toBeNull()
  })
  it('what is erased first, then deleted, then kept; columns and types in words (an unknown one never by its name)', () => {
    const contact = eraseScreen.cases.find((item) => item.id === 'contact')!.model.model.erase!.preview.value!
    expect(sectionsOf(contact).map((entry) => entry.section)).toEqual(['anonymised', 'deleted', 'kept'])
    // B-W2b-F54: a prospect's mails and history are blanked now, nothing of theirs is kept as it was.
    expect(sectionsOf(preview).map((entry) => entry.section)).toEqual(['anonymised'])
    expect(fieldKeys(['email', 'secretColumn', 'zzz'])).toEqual(['dp.erase.field.email', 'dp.erase.field.other'])
    expect(eraseTypeKey('NewTable')).toBe('dp.erase.type.other')
  })
})

describe('retention rules', () => {
  const rules = retentionScreen.cases[0]!.model.model.list.value!.rules
  const types = retentionScreen.cases[0]!.model.model.list.value!.types
  const manage = retentionCan(['privacy.view', 'privacy.retention.manage'])
  const view = retentionCan(['privacy.view'])
  const byType = (type: string) => rules.find((rule) => rule.recordType === type)!
  it('a held step: the right first, then the rule\'s code', () => {
    expect(ruleHeld(byType('ReportRun'), 'applyOn', view)).toBe('dp.ret.held.manage')
    expect(ruleHeld(byType('ReportRun'), 'applyOn', manage)).toBeNull()
    expect(ruleHeld(byType('CronRun'), 'applyOn', manage)).toBe('dp.ret.held.APPLYING')
    expect(ruleHeld(byType('ExportJob'), 'sweepNow', manage)).toBe('dp.ret.held.SWITCHED_OFF')
  })
  it('a batch sweep takes only rules that are on and only report', () => {
    expect(rules.filter(bulkSweepable).map((rule) => rule.recordType).sort()).toEqual(['InboundEmail', 'IntegrationErrorItem', 'Invoice', 'ReportRun'])
  })
  it('the form: type, whose, whole months 1-1200, an action the type takes, a legal reason', () => {
    const draft = { ruleId: null, recordType: 'ReportRun', companyId: '', keepMonths: '12', thenAction: 'DELETE' as const, legalReason: 'GDPR art. 5(1)(e)' }
    expect(ruleDraftHeld(draft, types, view)).toBe('dp.ret.held.manage')
    expect(ruleDraftHeld(draft, types, manage)).toBeNull()
    expect(ruleDraftHeld({ ...draft, companyId: 'c1' }, types, manage)).toBe('dp.ret.form.held.group')
    expect(ruleDraftHeld({ ...draft, keepMonths: '0' }, types, manage)).toBe('dp.ret.form.held.months')
    expect(ruleDraftHeld({ ...draft, keepMonths: '1201' }, types, manage)).toBe('dp.ret.form.held.months')
    expect(ruleDraftHeld({ ...draft, thenAction: 'ARCHIVE' }, types, manage)).toBe('dp.ret.form.held.action')
    expect(ruleDraftHeld({ ...draft, recordType: 'ExportJob', companyId: 'c1', thenAction: '' }, types, manage)).toBe('dp.ret.form.held.noAction')
    expect(ruleDraftHeld({ ...draft, legalReason: 'no' }, types, manage)).toBe('dp.ret.form.held.reason')
  })
  it('a change sends what differs; shortening, or another action while applying, asks a fresh code', () => {
    const rule = byType('InboundEmail')
    expect(rulePatch(rule, draftOfRule(rule))).toBeNull()
    expect(rulePatch(rule, { ...draftOfRule(rule), keepMonths: '12' })).toEqual({ keepMonths: 12 })
    expect(changeAsksCode(rule, { ...draftOfRule(rule), keepMonths: '12' })).toBe(true)
    expect(changeAsksCode(rule, { ...draftOfRule(rule), keepMonths: '36' })).toBe(false)
  })
  it('the last sweep and the period in words', () => {
    expect(lastSweepPhrase(null)).toEqual({ key: 'dp.ret.last.none' })
    expect(lastSweepPhrase(byType('ReportRun').lastSweep)).toEqual({ key: 'dp.ret.last.report', params: { due: 41 } })
    expect(lastSweepPhrase(byType('CronRun').lastSweep)).toEqual({ key: 'dp.ret.last.apply', params: { applied: 214, held: 0 } })
    expect(lastSweepPhrase(byType('Invoice').lastSweep)).toEqual({ key: 'dp.ret.last.failed' })
    expect(periodParts(30)).toEqual({ years: 2, months: 6 })
    expect(typeKey('Unknown', 'name')).toBe('dp.ret.type.other.name')
  })
})

// ---- every key in both languages ---------------------------------------------------------------------------------------------

const NS = 'admin-privacy-depth'
const has = (locale: (typeof LOCALES)[number], key: string) => {
  const words = messagesFor(locale, [NS])[NS] ?? {}
  return key in words || (`${key}_one` in words && `${key}_other` in words)
}
const ROOTS = [fileURLToPath(new URL('..', import.meta.url)), fileURLToPath(new URL('../../../me/my-data', import.meta.url))]
const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sources(path)
    return /\.tsx?$/.test(entry.name) && !entry.name.includes('.vitest.test.') ? [path] : []
  })
const OWN = [join(ROOTS[0]!, 'requests'), join(ROOTS[0]!, 'retention'), join(ROOTS[0]!, 'erase'), ROOTS[1]!]

const each = (prefix: string, codes: readonly string[], suffixes: readonly string[] = ['']) => codes.flatMap((code) => suffixes.map((suffix) => `${prefix}${code}${suffix}`))
const BUILT = [
  ...each('dp.held.', REQUEST_HELD),
  ...each('dp.kind.', DATA_REQUEST_KINDS),
  ...each('dp.kindHint.', DATA_REQUEST_KINDS),
  ...each('dp.personKind.', DATA_SUBJECT_KINDS),
  ...each('dp.new.findHint.', DATA_SUBJECT_KINDS),
  ...each('dp.status.', DATA_REQUEST_STATUSES),
  ...each('dp.record.decided.', DATA_REQUEST_STATUSES),
  ...each('dp.req.view.', REQUEST_VIEWS),
  ...each('dp.req.empty.', REQUEST_VIEWS),
  ...each('dp.erase.blocked.', ERASURE_BLOCKED),
  ...each('dp.erase.why.', KEPT_WHY),
  ...each('dp.erase.method.', ERASURE_METHODS),
  ...each('dp.erase.section.', ['anonymised', 'deleted', 'kept'], ['.title', '.intro', '.note']),
  ...each('dp.erase.type.', [...ERASURE_TYPES, 'other']),
  ...each('dp.erase.field.', [...ERASURE_FIELDS, 'other']),
  ...each('dp.form.', ['identity', 'extend', 'refuse', 'withdraw'], ['.title', '.intro', '.label', '.hint', '.save']),
  ...each('dp.my.state.', ['collecting', 'ready', 'handed', 'failed', 'waiting', 'closed']),
  ...each('dp.duty.', ['requests', 'retention'], ['.name', '.law']),
  ...each('dp.duty.state.', ['done', 'needs', 'review']),
  ...each('dp.ret.failure.', SWEEP_FAILURES),
  ...each('dp.ret.held.', RULE_HELD),
  ...each('dp.ret.kept.', KEPT_KEYS),
  ...each('dp.ret.ledger.', APPEND_ONLY_LEDGERS, ['.name', '.what']),
  ...each('dp.ret.mode.', SWEEP_MODES),
  ...each('dp.ret.purge.', PURGE_KEYS, ['.what', '.when', '.why']),
  ...each('dp.ret.state.', ['off', 'reporting', 'applying']),
  ...each('dp.ret.sweepHeld.', SWEEP_HELD, ['.short', '.long']),
  ...each('dp.ret.sweepStatus.', SWEEP_STATUSES),
  ...each('dp.ret.then.', RETENTION_ACTIONS),
  ...each('dp.ret.type.', [...RETENTION_TYPE_NAMES, 'other'], ['.name', '.countsFrom']),
  ...RETENTION_TYPE_NAMES.flatMap((type) => each(`dp.ret.type.${type}.does.`, RETENTION_ACTIONS)),
  'dp.ret.type.other.does',
]

describe('every key the screens name, in both languages', () => {
  it('the domain\'s lists are all worded here (a new code fails this test)', () => {
    expect(DATED_PURGES.map((purge) => purge.key).every((key) => (PURGE_KEYS as readonly string[]).includes(key))).toBe(true)
    expect(KEPT_FOR_GOOD.every((type) => (KEPT_KEYS as readonly string[]).includes(type))).toBe(true)
  })
  it('literal keys and the keys built from codes', () => {
    const literal = new Set<string>()
    for (const file of OWN.flatMap(sources)) for (const match of readFileSync(file, 'utf8').matchAll(/['"`](dp\.[A-Za-z0-9_.]*[A-Za-z0-9_])['"`]/g)) literal.add(match[1]!)
    const missing = [...literal, ...BUILT].filter((key) => LOCALES.some((locale) => !has(locale, key)))
    expect(missing).toEqual([])
    expect(literal.size).toBeGreaterThan(200)
  })
})

// ---- the design cases --------------------------------------------------------------------------------------------------------

const LEFT_KEY = /\bdp\.[a-zA-Z]+(?:\.[a-zA-Z_]+)+\b/
function render(screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(View, { model }))).replace(/<!-- -->/g, '')
}

describe('SCR-660, SCR-661 and SCR-662 draw every case in both languages with no key on screen', () => {
  for (const screen of [designScreen, eraseScreen, retentionScreen] as DesignScreen<unknown>[]) {
    for (const locale of LOCALES) {
      it(`${screen.screen} in ${locale}`, () => {
        for (const item of screen.cases) {
          const html = render(screen, item.model, locale)
          expect(html.length, item.id).toBeGreaterThan(500)
          expect(html.match(LEFT_KEY)?.[0] ?? null, `${item.id} (${locale})`).toBeNull()
        }
      })
    }
  }

  it('the list says the clock, the late banner and the duty lines; the list frame\'s keys sit in its footer', () => {
    const html = render(designScreen as DesignScreen<unknown>, designScreen.cases[0]!.model, 'en')
    expect(html).toContain('Data requests answered within 30 days')
    expect(html).toContain('1 request passed its due day')
    const clock = (request: typeof LATE_ERASURE) => renderToString(createElement(I18nProvider, { locale: 'en', messages: messagesFor('en', ['admin-privacy-depth']) }, createElement(Clock, { request, now: NOW, timeZone: 'Europe/Rome' })))
    expect(clock(LATE_ERASURE)).toContain('late: due 13')
    expect(clock(SOON_ACCESS)).toContain('due in 2')
    expect(clock(ERASED_DONE)).toContain('closed')
    expect(html).toContain('New data request')
    expect(html).toContain('aria-label="Keyboard keys of this list"')
  })

  it('without privacy.requests.view the list is not offered at all', () => {
    const html = render(designScreen as DesignScreen<unknown>, designScreen.cases.find((item) => item.id === 'no-permission')!.model, 'en')
    expect(html).not.toContain('Bruno Prova')
    expect(html).not.toContain('New data request')
  })

  it('retention: nothing deletes by itself; UNVERIFIED on every rule; the ledgers kept for good (the Owner decided), never a sweep', () => {
    const html = render(retentionScreen as DesignScreen<unknown>, retentionScreen.cases[0]!.model, 'en')
    expect(html).toContain('Nothing is deleted by itself')
    expect(html).toContain('UNVERIFIED')
    expect(html).toContain('Kept for good, never purged')
    expect(html).not.toContain('waits for the Owner')
    expect(html).toContain('Change history')
    expect(render(retentionScreen as DesignScreen<unknown>, retentionScreen.cases[0]!.model, 'it')).toContain('NON VERIFICATO')
  })
})
