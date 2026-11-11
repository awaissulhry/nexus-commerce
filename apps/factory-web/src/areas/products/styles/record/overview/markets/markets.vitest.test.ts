import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ApiError } from '../../../../../../lib/api/errors'
import type { DesignScreen } from '../../../../../../lib/design/design-screen'
import { LOCALES } from '../../../../../../lib/i18n/locales'
import { CATALOGUE, messagesFor } from '../../../../../../lib/i18n/messages'
import { I18nProvider } from '../../../../../../lib/i18n/provider'
import { designScreen } from '../fixtures'
import { failed, ready } from '../model'
import { demoMarkets, MARKET_CASES, marketsModel } from './fixtures'
import { codesToSend, MARKETS_CODE_KEYS, marketMarks, marketsHeld, marketsProblem, NS, pickChanged, pickChoices, saveHeld } from './model'

/** B-W2b-283 (FU1:01): the Overview's Markets — held reasons, the pick, refusals in words, every key in both languages. */

const error = (kind: ConstructorParameters<typeof ApiError>[0], status: number, code: string, issues: { path: string; message: string }[] = []) => new ApiError(kind, status, code, 'x', null, issues)

describe('the markets card and its pick', () => {
  it('holds Change… with why: reading, failed, no right, the edit rule, offline, saving', () => {
    expect(marketsHeld(marketsModel({ part: { status: 'loading' } }))).toBe('markets.held.reading')
    expect(marketsHeld(marketsModel({ part: failed('markets.problem.readFailed') }))).toBe('markets.held.failed')
    expect(marketsHeld(marketsModel({ part: ready(demoMarkets({ mayChange: false })) }))).toBe('markets.held.noRight')
    expect(marketsHeld(marketsModel({ part: ready(demoMarkets({ refusal: { code: 'EDIT_BLOCKED', message: 'x' } })) }))).toBe('markets.refusal.EDIT_BLOCKED')
    expect(marketsHeld(marketsModel({ part: ready(demoMarkets({ refusal: { code: 'SOMETHING_NEW', message: 'x' } })) }))).toBe('markets.refusal.other')
    expect(marketsHeld(marketsModel({ online: false }))).toBe('markets.held.offline')
    expect(marketsHeld(marketsModel({ busy: true }))).toBe('markets.held.busy')
    expect(marketsHeld(marketsModel())).toBeNull()
  })

  it('offers the company’s markets first, keeps a named one no longer offered; Save only when the set changes', () => {
    const view = demoMarkets({ codes: ['IT'], archived: true, other: true })
    expect(pickChoices(view).map((market) => market.code)).toEqual(['IT', 'DE', 'FR', 'CH', 'UK', 'ES', 'AT'])
    expect(pickChanged(view, ['ES', 'AT', 'IT'])).toBe(false)
    expect(pickChanged(view, ['IT', 'ES'])).toBe(true)
    expect(saveHeld(marketsModel({ part: ready(view), pick: { codes: ['AT', 'IT', 'ES'] } }))).toBe('markets.held.same')
    expect(saveHeld(marketsModel({ part: ready(view), pick: { codes: [] } }))).toBeNull()
    expect(codesToSend(view, ['ES', 'DE', 'IT', 'DE'])).toEqual(['IT', 'DE', 'ES'])
    const marks = Object.fromEntries(view.markets.map((market) => [market.code, marketMarks(market, view.style.companyId)]))
    expect(marks).toMatchObject({ IT: [], CH: ['markets.mark.off'], ES: ['markets.mark.archived'], AT: ['markets.mark.otherCompany'] })
  })

  it('says a refusal in our words and reads again where the server moved', () => {
    expect(marketsProblem(error('conflict', 409, 'version_conflict'))).toEqual({ key: 'markets.problem.moved', reload: true })
    expect(marketsProblem(error('conflict', 409, 'conflict', [{ path: 'refusal/EDIT_BLOCKED', message: 'x' }]))).toEqual({ key: 'markets.refusal.EDIT_BLOCKED', reload: true })
    expect(marketsProblem(error('conflict', 409, 'conflict'))).toEqual({ key: 'markets.problem.changed', reload: true })
    expect(marketsProblem(error('invalid', 400, 'invalid', [{ path: 'body/marketCodes/1', message: 'x' }]))).toEqual({ key: 'markets.problem.market', reload: true })
    expect(marketsProblem(error('forbidden', 403, 'forbidden')).key).toBe('markets.problem.forbidden')
    expect(marketsProblem(new Error('x')).key).toBe('markets.problem.failed')
  })
})

// ---- words ------------------------------------------------------------------------------------------------------------------

const HERE = fileURLToPath(new URL('.', import.meta.url))
const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? sources(join(dir, entry.name)) : /\.(ts|tsx)$/.test(entry.name) && !/vitest/.test(entry.name) ? [join(dir, entry.name)] : []))
const literalKeys = (): string[] => [
  ...new Set(sources(HERE).flatMap((file) => [...readFileSync(file, 'utf8').matchAll(/(?:\bw\(\s*|')((?:markets)\.[a-zA-Z][\w.]+)'/g)].map((match) => match[1]!).filter((key) => !key.endsWith('.'))))
]

describe('every key the markets name exists in it and en', () => {
  for (const locale of LOCALES) {
    it(`${NS} (${locale})`, () => {
      const dictionary = CATALOGUE[locale]?.[NS] ?? {}
      const has = (key: string) => key in dictionary || `${key}_other` in dictionary
      const keys = [...literalKeys(), ...MARKETS_CODE_KEYS]
      expect(keys.length).toBeGreaterThan(40)
      expect(keys.filter((key) => !has(key))).toEqual([])
    })
  }
})

describe('the w2b-283 cases draw in both languages with no key on screen', () => {
  const View = (designScreen as DesignScreen<unknown>).view as ComponentType<{ model: unknown }>
  for (const locale of LOCALES) {
    it(`SCR-342 w2b-283 cases in ${locale}`, () => {
      const cases = designScreen.cases.filter((item) => item.id.startsWith('w2b-283-'))
      expect(cases.map((item) => item.id)).toEqual(MARKET_CASES.map((item) => item.id))
      for (const item of cases) {
        const html = renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(View, { model: item.model })))
        expect(html.match(/\bmarkets\.[a-zA-Z]+(?:\.[a-zA-Z_]+)*\b/)?.[0] ?? null, `${item.id} (${locale})`).toBeNull()
        expect(html, item.id).toContain(locale === 'it' ? 'Mercati' : 'Markets')
      }
    })
  }
})
