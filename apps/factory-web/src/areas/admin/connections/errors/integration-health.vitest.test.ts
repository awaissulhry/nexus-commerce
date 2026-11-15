import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement, type ComponentType, type ReactNode } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ColDef } from '@nexus/ui/grid'
import { ERROR_REASONS, FIX_PLACES, RETRY_HELD } from '@nexus/factory-domain/integration-health/errors'
import { JOB_STATES, RUN_NOW_HELD } from '@nexus/factory-domain/integration-health/jobs'
import type { DesignScreen } from '../../../../lib/design/design-screen'
import { LOCALES, type Locale } from '../../../../lib/i18n/locales'
import { CATALOGUE, createTranslator, messagesFor, placeholdersOf } from '../../../../lib/i18n/messages'
import { I18nProvider } from '../../../../lib/i18n/provider'
import { designScreen as jobsScreen, DEMO_JOBS } from '../../security/jobs/fixtures'
import { jobOrder, nameKey, needsCount, runNowHeldKey, runNowReach, durationOf } from '../../security/jobs/model'
import { jobColumns } from '../../security/jobs/view/JobsCard'
import type { ErrorItem } from './api'
import { designScreen as testScreen } from './connection-test/fixtures'
import { designScreen as errorsScreen, DEMO_ITEMS } from './fixtures'
import { bulkHeldKey, bulkReach, dismissProblem, fixHref, KNOWN_OPERATIONS, operationWords, reasonWords, stateKey, testHeldKey, testWords } from './model'
import { errorColumns } from './view/ErrorQueueSection'

/**
 * Integration health on screen (B-W2b-415; SCR-600 error queue, SCR-601 jobs and integrations, SCR-602 Test and Reconnect):
 * every word in it and en with the same placeholders, every key the code names (literally or from a domain list) exists, the
 * pure rules, every design case drawn in both languages with no key left on screen, and each list's cells drawn alone.
 */

const NAMESPACE = 'admin-integration-health'
const words = (locale: Locale) => CATALOGUE[locale][NAMESPACE] ?? {}
const has = (key: string) => LOCALES.every((locale) => key in words(locale) || (`${key}_one` in words(locale) && `${key}_other` in words(locale)))
const LEFT_KEY = /\baih\.[a-zA-Z]+(?:\.[a-zA-Z_]+)+\b/
const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sources(path)
    return /\.tsx?$/.test(entry.name) && !entry.name.includes('.vitest.test.') && entry.name !== 'fixtures.ts' ? [path] : []
  })

describe('the words of integration health', () => {
  it('has the same keys and placeholders in it and en, all under aih.', () => {
    const en = words('en')
    const itc = words('it')
    expect(Object.keys(en).sort()).toEqual(Object.keys(itc).sort())
    for (const key of Object.keys(en)) {
      expect(key.startsWith('aih.'), key).toBe(true)
      expect(placeholdersOf(itc[key]!), key).toEqual(placeholdersOf(en[key]!))
    }
  })

  it('has every key its code names, literally or from a domain list', () => {
    const pattern = /['"`](aih\.[A-Za-z0-9_.]*[A-Za-z0-9_])['"`]/g
    const keys = new Set<string>()
    for (const folder of [join(ROOT, 'connections/errors'), join(ROOT, 'security/jobs')]) for (const file of sources(folder)) for (const match of readFileSync(file, 'utf8').matchAll(pattern)) keys.add(match[1]!)
    const built = [
      ...ERROR_REASONS.map((code) => `aih.reason.${code}`),
      ...['OPEN', 'RETRIED', 'DISMISSED', 'wentThrough'].map((state) => `aih.state.${state}`),
      ...KNOWN_OPERATIONS.map((operation) => `aih.op.${operation}`),
      ...[...RETRY_HELD, 'NO_RIGHT'].map((code) => `aih.held.retry.${code}`),
      ...[...RETRY_HELD, 'NO_RIGHT'].map((code) => `aih.bulk.left.retry.${code}`),
      ...['DISMISSED', 'NO_RIGHT'].flatMap((code) => [`aih.held.dismiss.${code}`, `aih.bulk.left.dismiss.${code}`]),
      ...FIX_PLACES.map((place) => `aih.action.fix.${place}`),
      ...JOB_STATES.map((state) => `aih.jobState.${state}`),
      ...[...RUN_NOW_HELD, 'NO_RIGHT'].flatMap((code) => [`aih.runNow.held.${code}`, `aih.runNow.left.${code}`]),
      ...['open', 'retried', 'dismissed', 'all'].flatMap((view) => [`aih.view.${view}`, `aih.empty.${view}.title`, `aih.empty.${view}.body`]),
      ...['account_paused', 'account_disabled', 'circuit_open', 'rate_limited', 'gateway_unavailable', 'fake_in_production', 'other'].map((code) => `aih.test.refused.${code}`),
      ...DEMO_JOBS.flatMap((job) => [`aih.job.${job.key}.name`, `aih.job.${job.key}.what`]),
    ]
    for (const key of [...keys, ...built]) expect(has(key), key).toBe(true)
  })
})

describe('the error queue rules', () => {
  it('says what failed and why in words, a code without words as data', () => {
    expect(operationWords({ source: 'CALL', operation: 'sdi.send_invoice', reasonCode: 'provider_error' })).toEqual({ key: 'aih.op.sdi.send_invoice', params: {} })
    expect(operationWords({ source: 'OUTBOX', operation: 'quote.sent', reasonCode: 'publish_failed' })).toEqual({ key: 'aih.op.event', params: { code: 'quote.sent' } })
    expect(operationWords({ source: 'OUTBOX', operation: 'email.send', reasonCode: 'job_failed' })).toEqual({ key: 'aih.op.job', params: { code: 'email.send' } })
    expect(operationWords({ source: 'CALL', operation: 'unknown.op', reasonCode: 'timeout' })).toEqual({ key: 'aih.op.other', params: { code: 'unknown.op' } })
    expect(reasonWords('00404')).toEqual({ key: 'aih.reason.other', params: { code: '00404' } })
    expect(stateKey({ state: 'RETRIED', retriedBySystem: true })).toBe('aih.state.wentThrough')
    expect(fixHref('/w/DEMO', 'invoices')).toBe('/w/DEMO/finance/invoices')
  })

  it('counts what a bulk action reaches and holds it when nothing can take it', () => {
    const reach = bulkReach(DEMO_ITEMS, 'retry')
    expect(reach.applies.map((item) => item.source)).toEqual(['OUTBOX', 'OUTBOX', 'WEBHOOK'])
    expect(reach.left).toEqual([
      { key: 'aih.bulk.left.retry.FROM_RECORD', count: 3 },
      { key: 'aih.bulk.left.retry.SIGNATURE', count: 1 },
    ])
    const calls = DEMO_ITEMS.filter((item) => item.source === 'CALL')
    expect(bulkHeldKey(calls, 'retry', true)).toBe('aih.bulk.none.retry')
    expect(bulkHeldKey(calls, 'dismiss', true)).toBeNull()
    expect(bulkHeldKey(calls, 'dismiss', false)).toBe('aih.held.retry.NO_RIGHT')
    expect(dismissProblem(' ')).toBe('aih.dismiss.required')
    expect(dismissProblem('ok')).toBe('aih.dismiss.short')
    expect(dismissProblem('Sent by hand')).toBeNull()
  })

  it('a test answer in words, and why Test or Reconnect is held', () => {
    const answer = { accountId: 'a', outcome: 'OK' as const, reason: null, message: null, httpStatus: 200, durationMs: 14, fake: true, reconnected: false, circuitBefore: null, testedAt: '2026-11-14T09:41:00.000Z' }
    expect(testWords(answer)).toEqual({ key: 'aih.test.okFake', tone: 'success', params: { ms: 14 } })
    expect(testWords({ ...answer, outcome: 'REFUSED', reason: 'circuit_open' }).key).toBe('aih.test.refused.circuit_open')
    expect(testWords({ ...answer, outcome: 'REFUSED', reason: 'odd' }).key).toBe('aih.test.refused.other')
    expect(testWords({ ...answer, outcome: 'FAILED', reason: 'timeout' }).key).toBe('aih.test.failed.timeout')
    const account = { status: 'ACTIVE' as const, mode: 'FAKE' as const, provider: 'SDI' }
    expect(testHeldKey(account, false, true)).toBeNull()
    expect(testHeldKey(account, false, false)).toBe('aih.test.held.right')
    expect(testHeldKey({ ...account, status: 'PAUSED' }, false, true)).toBeNull()
    expect(testHeldKey({ ...account, status: 'PAUSED' }, true, true)).toBe('aih.test.held.paused')
    expect(testHeldKey({ ...account, mode: 'LIVE', provider: 'SENDCLOUD' }, false, true)).toBe('aih.test.held.noProbe')
    expect(testHeldKey({ ...account, mode: 'LIVE', provider: 'ECB' }, false, true)).toBeNull()
  })
})

describe('the jobs rules', () => {
  it('orders the jobs that need a person first, says why Run now is held, and counts a bulk Run now', () => {
    const ordered = jobOrder(DEMO_JOBS, (job) => job.key)
    expect(ordered.slice(0, 3).map((job) => job.state)).toEqual(['stuck', 'failing', 'missed'])
    expect(needsCount(DEMO_JOBS)).toBe(3)
    const digest = DEMO_JOBS.find((job) => job.key === 'notifications.digest')!
    expect(runNowHeldKey(digest, true)).toBe('aih.runNow.held.SCHEDULE_ONLY')
    expect(runNowHeldKey(DEMO_JOBS[3]!, false)).toBe('aih.runNow.held.NO_RIGHT')
    const reach = runNowReach([DEMO_JOBS[0]!, DEMO_JOBS[3]!, digest], true)
    expect(reach.applies).toHaveLength(2)
    expect(reach.left).toEqual([{ key: 'aih.runNow.left.SCHEDULE_ONLY', count: 1 }])
    expect(nameKey({ key: 'odd.job', known: false })).toEqual({ key: 'aih.job.unknown.name', params: { code: 'odd.job' } })
    expect(durationOf(820)).toEqual({ key: 'aih.run.seconds', params: { count: 1 } })
    expect(durationOf(184_000)).toEqual({ key: 'aih.run.minutes', params: { count: 3 } })
  })
})

function render(screen: DesignScreen<unknown>, model: unknown, locale: Locale): string {
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(View, { model })))
}

describe('every design case draws in both languages with no key left on screen', () => {
  it('each screen has the states the design names', () => {
    const ids = (screen: DesignScreen<unknown>) => screen.cases.map((item) => item.id).join(' ')
    for (const state of ['loading', 'error', 'empty', 'no-permission', 'read-only', 'item-sdi', 'dismiss', 'retry-many']) expect(ids(errorsScreen as DesignScreen<unknown>)).toContain(state)
    for (const state of ['loading', 'error', 'empty', 'no-permission', 'read-only', 'run-now', 'history']) expect(ids(jobsScreen as DesignScreen<unknown>)).toContain(state)
    for (const state of ['ready', 'ok-fake', 'refused-paused', 'reconnected', 'held-right', 'held-no-probe']) expect(ids(testScreen as DesignScreen<unknown>)).toContain(state)
  })
  for (const screen of [errorsScreen, jobsScreen, testScreen] as DesignScreen<unknown>[]) {
    for (const locale of LOCALES) {
      it(`${screen.screen} in ${locale}: ${screen.cases.length} cases`, () => {
        for (const item of screen.cases) {
          const html = render(screen, item.model, locale)
          expect(html.length, item.id).toBeGreaterThan(500)
          expect(html.match(LEFT_KEY)?.[0] ?? null, `${screen.screen}/${item.id} (${locale})`).toBeNull()
        }
      })
    }
  }
})

/** One cell as the grid would draw it: its renderer with the row, or the text its value getter gives. */
function cellNode<T>(column: ColDef<T>, row: T): ReactNode {
  const renderer = column.cellRenderer
  if (renderer && typeof renderer !== 'string') return createElement(renderer as ComponentType<Record<string, unknown>>, { data: row, value: undefined })
  const value = typeof column.valueGetter === 'function' ? column.valueGetter({ data: row } as never) : undefined
  return value === null || value === undefined ? '' : String(value)
}

describe('the lists’ cells, drawn alone', () => {
  for (const locale of LOCALES) {
    it(`in ${locale}`, () => {
      const t = createTranslator(locale, words(locale))
      const tc = createTranslator(locale, CATALOGUE[locale]['admin-connections'] ?? {})
      const time = (iso: string | null) => iso ?? '—'
      const what = (item: ErrorItem) => t(operationWords(item).key, operationWords(item).params)
      const why = (item: Pick<ErrorItem, 'reasonCode'>) => t(reasonWords(item.reasonCode).key, reasonWords(item.reasonCode).params)
      const service = (item: Pick<ErrorItem, 'provider'>) => (item.provider ? tc(`conn.provider.${item.provider}.name`) : t('aih.service.factory'))
      const name = (job: { key: string; known: boolean }) => t(nameKey(job).key, nameKey(job).params)
      const nodes: ReactNode[] = [
        ...DEMO_ITEMS.flatMap((item) => errorColumns({ t, time: (iso) => iso, what, why, service }).map((column) => cellNode(column, item))),
        ...DEMO_JOBS.flatMap((job) => jobColumns({ t, time, name }).map((column) => cellNode(column, job))),
      ]
      const html = renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell', NAMESPACE, 'admin-connections']) }, ...nodes))
      expect(html.match(LEFT_KEY)?.[0] ?? null).toBeNull()
      expect(html).toContain('FT-2026-0041')
    })
  }
})
