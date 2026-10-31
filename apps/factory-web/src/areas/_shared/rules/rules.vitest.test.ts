import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { KINDS, RULE_KINDS, type RuleKind } from '@nexus/factory-domain/alerts/kinds'
import { cooldownWords, ruleSentence } from '@nexus/factory-domain/alerts/rules'
import { ApiError } from '../../../lib/api/errors'
import { LOCALES } from '../../../lib/i18n/locales'
import { CATALOGUE, createTranslator, messagesFor, placeholdersOf } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { DEMO_CHOICES, DEMO_RULES, demoRule } from './demo'
import { RuleSentence } from './view/RuleSentence'
import { changeCount, changesOf, defaultRecipient, cooldownOptions, createBodyOf, draftOf, draftProblems, goesToWords, newDraft, numbersWords, placeOf, placeOptions, placeValue, refusalOf, testBodyOf, THRESHOLD_FIELDS, wholeOf } from './model'

/** The exception rules' shared part (B-W2a-78): the numbers per kind, the draft and what a save sends, the words. */

const en = createTranslator('en', CATALOGUE.en.rules ?? {})
const it_ = createTranslator('it', CATALOGUE.it.rules ?? {})

describe('the numbers of each kind are factory-domain’s', () => {
  it('each number field’s bounds pass and fail exactly where the domain’s threshold does', () => {
    for (const kind of RULE_KINDS) {
      const fields = THRESHOLD_FIELDS[kind]
      const defaults = KINDS[kind].builtIn.threshold
      expect(Object.keys(defaults).filter((key) => key !== 'workingDays').sort(), kind).toEqual(fields.numbers.map((field) => field.key).sort())
      expect('workingDays' in defaults, kind).toBe(fields.workingDays)
      for (const field of fields.numbers) {
        const at = (value: number) => KINDS[kind].threshold.safeParse({ ...defaults, [field.key]: value }).success
        expect([at(field.min - 1), at(field.min), at(field.max), at(field.max + 1)], `${kind}.${field.key}`).toEqual([false, true, true, false])
      }
    }
  })

  it('a number as typed: whole numbers only; out of bounds says its bounds', () => {
    expect([wholeOf('24'), wholeOf(' 3 '), wholeOf('2.5'), wholeOf(''), wholeOf('-1'), wholeOf('12345')]).toEqual([24, 3, null, null, null, null])
    const hold = draftOf(demoRule(1, 'HOLD_TOO_LONG'))
    expect(draftProblems(hold)).toEqual([])
    expect(draftProblems({ ...hold, numbers: { hours: '900' } })).toEqual([{ key: 'hours', min: 1, max: 720 }])
    expect(draftProblems({ ...hold, numbers: { hours: '' } })).toEqual([{ key: 'hours', min: 1, max: 720 }])
    expect(draftProblems(draftOf(demoRule(2, 'MATERIAL_SHORT')))).toEqual([])
  })
})

describe('a rule’s draft and what a save sends', () => {
  const hold = demoRule(1, 'HOLD_TOO_LONG')

  it('a change sends only what changed (the numbers once, the place as company and site)', () => {
    const draft = draftOf(hold)
    expect(changesOf(hold, draft)).toEqual({})
    const body = changesOf(hold, { ...draft, numbers: { hours: '48' }, place: 's:c1:s1', email: true, cooldownMinutes: 240, enabled: false })
    expect(body).toEqual({ threshold: { hours: 48 }, companyId: 'c1', siteId: 's1', channels: ['IN_APP', 'EMAIL'], cooldownMinutes: 240, enabled: false })
    expect(changeCount(body)).toBe(5)
    const cert = demoRule(2, 'CERTIFICATE_EXPIRING')
    expect(changesOf(cert, { ...draftOf(cert), workingDays: true })).toEqual({ threshold: { daysBefore: 30, workingDays: true } })
  })

  it('a new rule: the kind’s numbers, severity and cooldown; its built-in rule’s role; the first place offered; the bell', () => {
    const kind = { kind: 'HOLD_TOO_LONG' as RuleKind, trigger: 'CONDITION' as const, recordType: 'QualityHold', defaults: { hours: 24 } }
    const draft = newDraft(kind, DEMO_RULES, placeOptions(DEMO_CHOICES, null))
    expect(draft).toMatchObject({ numbers: { hours: '24' }, severity: 'WARNING', cooldownMinutes: 1440, place: '', email: false, enabled: true })
    expect(draft.recipientRoleId).toBe(DEMO_RULES.find((rule) => rule.ruleKind === 'HOLD_TOO_LONG')!.recipient!.roleId)
    expect(createBodyOf({ ...draft, place: 'c:c1' })).toEqual({ ruleKind: 'HOLD_TOO_LONG', threshold: { hours: 24 }, severity: 'WARNING', companyId: 'c1', siteId: null, recipientRoleId: draft.recipientRoleId, channels: ['IN_APP'], cooldownMinutes: 1440, enabled: true })
    expect(testBodyOf({ ...draft, numbers: { hours: '6' } })).toEqual({ threshold: { hours: 6 }, companyId: null, siteId: null })
    // A built-in rule that tells nobody (a seed's): the kind's own system role among the roles offered.
    const silent = DEMO_RULES.map((rule) => (rule.ruleKind === 'CERTIFICATE_EXPIRING' ? { ...rule, recipient: null } : rule))
    const quality = DEMO_CHOICES.roles.find((role) => role.key === 'quality_inspector')!.id
    expect(defaultRecipient('CERTIFICATE_EXPIRING', silent, DEMO_CHOICES.roles)).toBe(quality)
    expect(defaultRecipient('CERTIFICATE_EXPIRING', silent, [])).toBeNull()
  })

  it('places: everywhere, each company, its sites; the rule’s own place kept when it cannot be chosen', () => {
    expect([placeValue({ companyId: null, siteId: null }), placeValue({ companyId: 'c', siteId: null }), placeValue({ companyId: 'c', siteId: 's' })]).toEqual(['', 'c:c', 's:c:s'])
    expect([placeOf(''), placeOf('c:c'), placeOf('s:c:s'), placeOf('x')]).toEqual([{ companyId: null, siteId: null }, { companyId: 'c', siteId: null }, { companyId: 'c', siteId: 's' }, { companyId: null, siteId: null }])
    expect(placeOptions(DEMO_CHOICES, null).map((option) => option.value)).toEqual(['', `c:${DEMO_CHOICES.companies[0]!.id}`, ...DEMO_CHOICES.companies[0]!.sites.map((site) => `s:${DEMO_CHOICES.companies[0]!.id}:${site.id}`)])
    const narrow = { ...DEMO_CHOICES, everywhere: false }
    expect(placeOptions(narrow, { value: '', label: null })[0]).toEqual({ value: '', name: null, kind: 'everywhere' })
    expect(placeOptions(narrow, { value: 's:c:s', label: 'Plant 9' })[0]).toEqual({ value: 's:c:s', name: 'Plant 9', kind: 'site' })
    expect(cooldownOptions(90)).toEqual([0, 60, 90, 240, 1440, 4320, 10_080])
  })

  it('a refused save in words: the bell, the place, changed meanwhile, nothing changed, the numbers, no right, gone, offline', () => {
    const error = (kind: ApiError['kind'], status: number, path?: string) => new ApiError(kind, status, 'x', 'x', null, path ? [{ path }] : [])
    expect(refusalOf(error('conflict', 409, 'body/channels'))).toBe('refusal.noBell')
    expect(refusalOf(error('conflict', 409, 'body/siteId'))).toBe('refusal.siteNeedsCompany')
    expect(refusalOf(error('conflict', 409, 'rule/UNCHANGED'))).toBe('refusal.unchanged')
    expect(refusalOf(error('conflict', 409, 'version'))).toBe('refusal.changed')
    expect(refusalOf(error('invalid', 400, 'body/threshold'))).toBe('refusal.numbers')
    expect(refusalOf(error('invalid', 400, 'body/recipientRoleId'))).toBe('refusal.role')
    expect(refusalOf(error('forbidden', 403))).toBe('refusal.forbidden')
    expect(refusalOf(error('not_found', 404))).toBe('refusal.gone')
    expect(refusalOf(error('unavailable', 503))).toBe('refusal.offline')
    expect(refusalOf(new Error('x'))).toBe('refusal.failed')
  })
})

describe('the words are the domain’s, in both languages', () => {
  it('each kind’s label is factory-domain’s, in English and Italian', () => {
    for (const kind of RULE_KINDS) {
      expect(en(`kind.${kind}`)).toBe(KINDS[kind].label.en)
      expect(it_(`kind.${kind}`)).toBe(KINDS[kind].label.it)
    }
  })

  it('RuleSentence’s words, filled in, are the API’s sentence (factory-domain ruleSentence) for every kind and both languages', () => {
    for (const locale of LOCALES) {
      const t = locale === 'en' ? en : it_
      for (const kind of RULE_KINDS) {
        for (const place of [null, 'Demo plant A1']) {
          const rule = demoRule(1, kind, { place: { companyId: place ? 'c' : null, siteId: place ? 's' : null, label: place } })
          const fields = THRESHOLD_FIELDS[kind]
          const numbers = Object.fromEntries(
            fields.numbers.map((field) => {
              const count = Number(rule.threshold[field.key])
              return [field.key, field.unit === 'hours' ? t('unit.hoursShort', { count }) : t(fields.workingDays && rule.threshold.workingDays === true ? 'unit.workingDays' : 'unit.days', { count })]
            }),
          )
          const when = t(`when.${kind}`, numbers)
          const sentence = t(place ? 'sentence.full' : 'sentence.nowhere', { when, place: place ? `${t('place.at')} ${place}` : '', recipient: rule.recipient!.name, channels: t('channels.bell'), cooldown: cooldownWords(rule.cooldownMinutes, locale) })
          const domain = ruleSentence({ ruleKind: kind, threshold: rule.threshold, channels: rule.channels, cooldownMinutes: rule.cooldownMinutes }, { place, recipient: rule.recipient!.name }, locale)
          expect(sentence, `${locale} ${kind} ${place ?? 'everywhere'}`).toBe(domain)
        }
      }
    }
  })

  it('a rule’s numbers and whom it tells, in words', () => {
    expect(numbersWords('HOLD_TOO_LONG', { hours: 24 }, en)).toBe('24 h')
    expect(numbersWords('CERTIFICATE_EXPIRING', { daysBefore: 30, workingDays: true }, it_)).toBe('30 giorni lavorativi')
    expect(numbersWords('MATERIAL_SHORT', {}, en)).toBe('—')
    expect(goesToWords(demoRule(1, 'HOLD_TOO_LONG', { place: { companyId: 'c', siteId: 's', label: 'Demo plant A1' } }), en)).toBe('Quality inspector at Demo plant A1')
    expect(goesToWords(demoRule(1, 'ORDER_LATE_RISK'), it_)).toBe('Planner, ovunque')
  })

  it('the same keys and placeholders in both languages, no empty text', () => {
    const enc = CATALOGUE.en.rules ?? {}
    const itc = CATALOGUE.it.rules ?? {}
    expect(Object.keys(itc).sort()).toEqual(Object.keys(enc).sort())
    for (const key of Object.keys(enc)) {
      expect(itc[key]?.trim(), `it ${key}`).not.toBe('')
      expect(placeholdersOf(itc[key] ?? ''), key).toEqual(placeholdersOf(enc[key] ?? ''))
    }
  })
})

describe('RuleSentence (the new part)', () => {
  const hold = demoRule(1, 'HOLD_TOO_LONG', { place: { companyId: 'c', siteId: 's', label: 'Demo plant A1' } })
  const draw = (mode: 'read' | 'edit', locale: (typeof LOCALES)[number], draft = draftOf(hold)) =>
    renderToString(
      createElement(
        I18nProvider,
        { locale, messages: messagesFor(locale, ['rules']) },
        createElement(RuleSentence, { draft, mode, names: { place: 'Demo plant A1', recipient: 'Quality inspector' }, places: placeOptions(DEMO_CHOICES, { value: placeValue(hold.place), label: hold.place.label }), roles: DEMO_CHOICES.roles, onChange: () => undefined }),
      ),
    )
  const text = (html: string) => html.replace(/<[^>]+>/g, '').replace(/&#x27;/g, "'")

  it('read: the API’s sentence, the values in bold, in both languages', () => {
    expect(text(draw('read', 'en'))).toBe(hold.sentence.en)
    expect(text(draw('read', 'it'))).toBe(hold.sentence.it)
    expect(draw('read', 'en')).toContain('<b class="fw-rule-value">24 h</b>')
  })

  it('edit: every part is a field inside the sentence, each named; a number out of bounds says its bounds', () => {
    const html = draw('edit', 'en')
    for (const label of ['Hours', 'Where it looks', 'Who is told', 'How they are told', 'How often at most']) expect(html).toContain(`aria-label="${label}"`)
    expect(html).toContain('When goods are on hold longer than')
    expect(html).toContain('<option value="s:c:s" selected="">at Demo plant A1</option>')
    const wrong = draw('edit', 'en', { ...draftOf(hold), numbers: { hours: '900' } })
    expect(wrong).toContain('aria-invalid="true"')
    const cert = demoRule(2, 'CERTIFICATE_EXPIRING')
    expect(draw('edit', 'it', draftOf(cert))).toContain('aria-label="Giorni di calendario o lavorativi"')
  })
})
