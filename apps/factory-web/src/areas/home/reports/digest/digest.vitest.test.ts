import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ROUTE_SCOPES as DOMAIN_ROUTE_SCOPES } from '@nexus/factory-domain/alert-routes/rules'
import { DIGEST_SECTIONS as DOMAIN_SECTIONS } from '@nexus/factory-domain/insights-digest/digest'
import { WIP_AGE_BUCKETS } from '@nexus/factory-domain/insights/kpis/wip'
import type { DesignScreen } from '../../../../lib/design/design-screen'
import { ApiError } from '../../../../lib/api/errors'
import { LOCALES } from '../../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../../lib/i18n/messages'
import { I18nProvider } from '../../../../lib/i18n/provider'
import { designScreen as routesScreen } from '../../../_shared/rules/routes/fixtures'
import { placeOptions, routeHeld, routeProblem, scopesOffered } from '../../../_shared/rules/routes/model'
import { ROUTE_SCOPES } from '../../../_shared/rules/routes/api'
import { designScreen as wipScreen } from '../../../production/reports/wip-ageing/fixtures'
import { AGE_BANDS } from '../../../production/reports/wip-ageing/api'
import { byLine, oldWaiting, wipAgeingAllowed } from '../../../production/reports/wip-ageing/model'
import { designScreen as flowScreen } from '../../today/flow-value/fixtures'
import { stageValueText, totalOf } from '../../today/flow-value/model'
import { DIGEST_SECTIONS } from './api'
import { designScreen as digestScreen } from './fixtures'
import { changesOf, daysWords, draftHeld, draftOf, heldKey, withDay, withSection, writeProblem } from './model'
import { designScreen as emailMeScreen } from './subscribe/fixtures'
import { draftChanges, emailMeHeld, emailMeProblem, newDraft } from './subscribe/model'

/** The owner digest, "E-mail me this", WIP ageing, Today's value per stage and alert routes on screen (B-W2b-435). */

const en = createTranslator('en', messagesFor('en', ['home-digest'])['home-digest']!)
const it_ = createTranslator('it', messagesFor('it', ['home-digest'])['home-digest']!)

describe('the codes mirror factory-domain and each has its words', () => {
  it('sections, scopes and age bands', () => {
    expect([...DIGEST_SECTIONS]).toEqual([...DOMAIN_SECTIONS])
    expect([...ROUTE_SCOPES]).toEqual([...DOMAIN_ROUTE_SCOPES])
    expect([...AGE_BANDS]).toEqual([...WIP_AGE_BUCKETS])
    for (const t of [en, it_]) {
      for (const section of DIGEST_SECTIONS) expect(t(`digest.section.${section}`)).not.toBe(`digest.section.${section}`)
      for (const scope of ROUTE_SCOPES) expect(t(`routes.scope.${scope}`)).not.toBe(`routes.scope.${scope}`)
      for (const band of AGE_BANDS) expect(t(`wip.band.${band}`)).not.toBe(`wip.band.${band}`)
      for (const day of [1, 2, 3, 4, 5, 6, 7]) expect(t(`digest.day.${day}`)).not.toBe(`digest.day.${day}`)
    }
  })
})

describe('the digest form', () => {
  const setting = { saved: true, enabled: false, enabledAt: null, companyId: null, sendTime: '07:30', timeZone: 'Europe/Rome', weekdays: [1, 2, 3, 4, 5], locale: 'it' as const, sections: [...DIGEST_SECTIONS], lastSentAt: null, version: 2 }

  it('counts its changes and says why Save waits', () => {
    const draft = draftOf(setting)
    expect(changesOf(draft, setting)).toBe(0)
    expect(draftHeld(draft, 0)).toBe('digest.held.nothing')
    const changed = { ...draft, enabled: true, weekdays: withDay(draft.weekdays, 6), sections: withSection(draft.sections, 'ALERTS') }
    expect(changed.weekdays).toEqual([1, 2, 3, 4, 5, 6])
    expect(changed.sections).toEqual(['SHIPPED', 'LATE', 'NEW_ORDERS', 'WIP_STUCK', 'APPROVALS'])
    expect(withSection(changed.sections, 'ALERTS')).toEqual([...DIGEST_SECTIONS])
    expect(changesOf(changed, setting)).toBe(3)
    expect(draftHeld(changed, 3)).toBeNull()
    expect(draftHeld({ ...changed, weekdays: [] }, 3)).toBe('digest.held.days')
    expect(draftHeld({ ...changed, sendTime: '7:3' }, 3)).toBe('digest.held.time')
    expect(draftHeld({ ...changed, sections: [] }, 3)).toBe('digest.held.sections')
    expect(heldKey('MAIL_OFF')).toBe('digest.held.mailOff')
    expect(heldKey(null)).toBeNull()
    expect(daysWords([1, 2, 3, 4, 5], en)).toBe('Monday to Friday')
    expect(daysWords([1, 3], it_)).toBe('Lunedì, Mercoledì')
  })

  it('says a refusal in its own words', () => {
    expect(writeProblem(new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: 'digest/MAIL_OFF', message: 'x' }]))).toBe('digest.error.mailOff')
    expect(writeProblem(new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: 'version', message: 'x' }]))).toBe('digest.error.stale')
    expect(writeProblem(new ApiError('invalid', 400, 'validation_failed', 'x', null, [{ path: 'body/sendTime', message: 'x' }]))).toBe('digest.error.invalid')
    expect(writeProblem(new Error('boom'))).toBe('digest.error.save')
  })
})

describe('"E-mail me this"', () => {
  const filters = [{ key: 'site', label: 'Site', kind: 'site' as const, default: null, choices: [] }, { key: 'state', label: 'When', kind: 'choice' as const, default: null, choices: [{ value: 'LATE', label: 'Late' }] }]
  it('starts from the page’s filters and counts what changed', () => {
    const draft = newDraft(filters, { state: 'LATE', other: 'x' }, 'en')
    expect(draft).toEqual({ sendTime: '07:00', weekdays: [1, 2, 3, 4, 5], locale: 'en', filters: { site: null, state: 'LATE' } })
    expect(draftChanges(draft, null, filters)).toBe(1)
    const row = { id: 's', reportKey: 'k', filters: { state: 'LATE' }, siteId: null, sendTime: '07:00', timeZone: 'Europe/Rome', weekdays: [1, 2, 3, 4, 5], locale: 'en' as const, active: true, lastSentAt: null, nextAt: null, version: 1 }
    expect(draftChanges(draft, row, filters)).toBe(0)
    expect(emailMeHeld(draft, 0)).toBe('emailMe.held.nothing')
    expect(emailMeHeld({ ...draft, weekdays: [] }, 1)).toBe('emailMe.held.days')
    expect(emailMeProblem(new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: 'subscription/OWN_MAIL', message: 'x' }]))).toBe('emailMe.error.ownMail')
  })
})

describe('WIP ageing, value per stage, routes', () => {
  it('groups the stages by line, no line last; sums what waited over 10 days', () => {
    const wip = wipScreen.cases[0]!.model.read
    if (wip.status !== 'ready') throw new Error('fixture')
    const lines = byLine(wip.data)
    expect(lines.map((line) => line.line?.code ?? null)).toEqual(['L1', 'L2', null])
    expect(lines[0]!.waiting).toBe(68)
    expect(oldWaiting(wip.data)).toBe(16)
    expect(wipAgeingAllowed(['home.kpis.view', 'production.reports.view'])).toBe(true)
    expect(wipAgeingAllowed(['production.reports.view'])).toBe(false)
  })

  it('writes a stage’s value at cost; no total with an unknown stage', () => {
    expect(stageValueText(1846000, 'EUR', 'en')).toBe('€18,460')
    expect(stageValueText(null, 'EUR', 'en')).toBeNull()
    const flow = flowScreen.cases[0]!.model.read
    if (flow.status !== 'ready') throw new Error('fixture')
    expect(totalOf(flow.data)).toBe(2199000)
    expect(totalOf({ ...flow.data, mixedCurrencies: true })).toBeNull()
  })

  it('offers the places inside the rule and holds Add with why', () => {
    const read = routesScreen.cases[0]!.model.read
    if (read.status !== 'ready' || !read.data.choices) throw new Error('fixture')
    expect(scopesOffered(read.data.choices)).toEqual(['COMPANY', 'SITE', 'LINE', 'CUSTOMER'])
    expect(placeOptions(read.data.choices, 'LINE').map((place) => place.label)).toEqual(['NORD › L1 · Linea Demo 1'])
    expect(routeHeld(null, { count: 0, max: 50, offline: false, busy: false })).toBe('routes.held.place')
    expect(routeHeld({ scope: 'SITE', scopeId: 's', who: 'ROLE', roleId: '', userId: '' }, { count: 0, max: 50, offline: false, busy: false })).toBe('routes.held.who')
    expect(routeHeld({ scope: 'SITE', scopeId: 's', who: 'ROLE', roleId: 'r', userId: '' }, { count: 50, max: 50, offline: false, busy: false })).toBe('routes.held.tooMany')
    expect(routeProblem(new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: 'route/WIDER', message: 'x' }]))).toBe('routes.error.place')
    expect(routeProblem(new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: 'route/DUPLICATE', message: 'x' }]))).toBe('routes.error.duplicate')
  })
})

const LEFT_KEY = /\b(?:digest|emailMe|wip|flowValue|routes|today|filters|period|report|common)\.[a-zA-Z_][a-zA-Z0-9_-]*(?:\.[a-zA-Z0-9_-]+)*\b/
const LEFT_PLACEHOLDER = /\{[a-zA-Z]+\}/
/** Words that look like keys but are data: an e-mail address, a link, a report's key. */
const SAID = /https?:\/\/[^\s<"]+|\b[\w.-]+@[\w.-]+\.\w+\b|\/home\/reports\/[a-z.-]+|\b(?:sales|production|finance|planning|purchasing|quality|compliance)\.[a-z]+-[a-z-]+\b/g

function render(screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(View, { model })))
}

describe('every design case draws in both languages with no key left on screen', () => {
  for (const screen of [digestScreen, emailMeScreen, wipScreen, flowScreen, routesScreen] as unknown as DesignScreen<unknown>[]) {
    it(`${screen.screen}: ${screen.cases.length} cases × it, en`, () => {
      for (const item of screen.cases) {
        for (const locale of LOCALES) {
          const html = render(screen, item.model, locale).replace(SAID, '')
          expect(html.length, `${screen.screen}/${item.id}`).toBeGreaterThan(200)
          expect(html.match(LEFT_KEY)?.[0] ?? null, `${screen.screen}/${item.id} (${locale})`).toBeNull()
          expect(html.match(LEFT_PLACEHOLDER)?.[0] ?? null, `${screen.screen}/${item.id} (${locale}) placeholder`).toBeNull()
        }
      }
    })
  }

  it('the preview shows the e-mail itself; the owner’s switches and who gets it', () => {
    const owner = render(digestScreen as unknown as DesignScreen<unknown>, digestScreen.cases.find((item) => item.id === 'owner')!.model, 'en')
    expect(owner).toContain('Il riepilogo del mattino')
    expect(owner).toContain('The morning e-mail of each company')
    expect(owner).toContain('Sam Esempio')
    const english = render(digestScreen as unknown as DesignScreen<unknown>, digestScreen.cases.find((item) => item.id === 'english')!.model, 'it')
    expect(english).toContain('Your morning summary')
  })
})
