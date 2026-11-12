import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ApiError } from '../../../../lib/api/errors'
import type { DesignScreen } from '../../../../lib/design/design-screen'
import { LOCALES } from '../../../../lib/i18n/locales'
import { CATALOGUE, messagesFor } from '../../../../lib/i18n/messages'
import { I18nProvider } from '../../../../lib/i18n/provider'
import { readScan } from '../../../scan/scan-model'
import { FLOOR_NAMESPACES } from '../../routes'
import { kitProblemOf } from '../kit/api'
import { designScreen as kitScreen } from '../kit/fixtures'
import { kitHeldNow, kitOf, kitState, KIT_REFUSALS } from '../kit/model'
import { designScreen as walkScreen, LIST, PICKED, STOPS, WALK } from './fixtures'
import { codeOfStop, nextStop, openStops, stopBody, stopBounds, stopHeld, stopKey, stopOfScan, takesWhole, walkSummary, WALK_REFUSALS } from './model'

/**
 * B-W2b-310: the pick list by bin and kit staging on Pick & issue — the rules without a screen, the kit's refusals, and every case of
 * SCR-384 and SCR-385 drawn in both languages with no key left, no secret and no money (the floor tasks' sweep reads only
 * `tasks/*\/fixtures.ts`; these two live one folder deeper). Made-up work orders, lots, hides and places.
 */

const none: ReadonlySet<string> = new Set()

describe('the pick list by bin', () => {
  it('finds the stop a scan names: a hide by its tag, a lot by its label (the first still to take)', () => {
    const hide = STOPS[0]!.hideCode!
    expect(stopOfScan(WALK, none, readScan(hide, null))?.turn).toBe(1)
    expect(stopOfScan(WALK, none, readScan('lot-demo-0031', null))?.turn).toBe(3)
    expect(stopOfScan(WALK, none, readScan('LOT-DEMO-9999', null))).toBeNull()
    // Taken on this tablet: no longer a stop to take.
    expect(stopOfScan(WALK, new Set([stopKey(STOPS[0]!)]), readScan(hide, null))).toBeNull()
  })
  it('says why a stop is not taken now; the next stop is the first that may be taken', () => {
    expect(STOPS.map((stop) => stopHeld(stop))).toEqual([null, null, null, null, 'onHold', 'blocked'])
    expect(nextStop(WALK, none)?.turn).toBe(1)
    expect(nextStop(WALK, new Set([stopKey(STOPS[0]!), stopKey(STOPS[1]!)]))?.turn).toBe(3)
    expect(openStops(null, none)).toEqual([])
  })
  it('a hide is taken whole; a lot by its quantity, at most the stop\'s, from the stop\'s place', () => {
    expect(takesWhole(STOPS[0]!)).toBe(true)
    expect(stopBody(STOPS[0]!)).toEqual({ code: STOPS[0]!.hideCode, fromLocationId: STOPS[0]!.location.id })
    expect(stopBounds(STOPS[2]!)).toEqual({ min: 0.01, max: 96, decimals: 2, suggested: 96, covered: false })
    expect(stopBody(STOPS[2]!, { value: 40.5, decimals: 2 })).toEqual({ code: 'LOT-DEMO-0031', fromLocationId: STOPS[2]!.location.id, quantity: '40.50' })
    expect(codeOfStop(STOPS[3]!)).toBe('LOT-DEMO-0052')
  })
  it('sums the walk: places with something to take, the first', () => {
    expect(walkSummary(WALK, none)).toEqual({ places: 5, first: 'A1-STORE-01', stops: 6 })
    expect(walkSummary(WALK, new Set([stopKey(STOPS[0]!)])).first).toBe('A1-STORE-02')
  })
})

describe('kit staging', () => {
  it('reads its state from the check and the ticks', () => {
    expect(kitState(kitOf(WALK, LIST))).toBe('partly')
    expect(kitState(kitOf(WALK, PICKED))).toBe('complete')
    expect(kitState(kitOf({ ...WALK, kit: { ...WALK.kit, checkedAt: '2026-11-12T09:40:00.000Z' } }, PICKED))).toBe('checked')
  })
  it('holds Kit complete with the office\'s own rules, offline and while sending', () => {
    const online = { online: true, busy: false }
    expect(kitHeldNow(kitOf(WALK, LIST), 'complete', online)).toEqual({ held: 'LINES_SHORT', count: 3 })
    expect(kitHeldNow(kitOf(WALK, PICKED), 'complete', online)).toEqual({ held: null })
    expect(kitHeldNow(kitOf(WALK, PICKED), 'complete', { online: false, busy: false })).toEqual({ held: 'offline' })
    expect(kitHeldNow(kitOf({ ...WALK, kit: { ...WALK.kit, checkedAt: '2026-11-12T09:40:00.000Z' } }, PICKED), 'complete', online)).toEqual({ held: 'ALREADY_CHECKED' })
    expect(kitHeldNow(kitOf({ ...WALK, workOrder: { ...WALK.workOrder, status: 'COMPLETED' } }, PICKED), 'stage', online)).toEqual({ held: 'WORK_ORDER_NOT_OPEN' })
  })
  it('reads the office\'s kit refusals: kit/<CODE>, a place no kit waits at, a label no place carries', () => {
    expect(kitProblemOf(new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: 'kit/LINES_SHORT', message: 'short' }]))).toMatchObject({ kind: 'refused', code: 'LINES_SHORT' })
    expect(kitProblemOf(new ApiError('invalid', 400, 'validation_failed', 'x', null, [{ path: 'body/locationId', message: 'workshop' }]))).toMatchObject({ kind: 'refused', code: 'NOT_A_KIT_PLACE' })
    expect(kitProblemOf(new ApiError('not_found', 404, 'not_found', 'x'), true)).toMatchObject({ kind: 'refused', code: 'NOT_A_PLACE' })
    expect(kitProblemOf(new ApiError('conflict', 409, 'conflict', 'The kit changed', null, []))).toMatchObject({ kind: 'conflict' })
  })
  it('every refusal the two parts name has its words in both languages', () => {
    for (const locale of LOCALES) {
      const words = CATALOGUE[locale]['floor-issue'] ?? {}
      for (const code of [...WALK_REFUSALS, ...KIT_REFUSALS]) {
        expect(words[`refusal.${code}.message`], `${locale} ${code}`).toBeTruthy()
        expect(words[`refusal.${code}.fix`], `${locale} ${code}`).toBeTruthy()
      }
    }
  })
})

// ---- SCR-384 and SCR-385 in both languages ----------------------------------------------------------------------------------------

const TOP = [...new Set(FLOOR_NAMESPACES.flatMap((namespace) => Object.keys(CATALOGUE.en[namespace] ?? {}).map((key) => key.split('.')[0]!)))]
const LEFT_KEY = new RegExp(`(?:^|[\\s>"])(?:${TOP.join('|')})\\.[a-zA-Z]+(?:\\.[a-zA-Z_]+)*`)

function render(screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, FLOOR_NAMESPACES) }, createElement(View, { model })))
}

describe('every case of SCR-384 and SCR-385 draws in both languages', () => {
  for (const screen of [walkScreen, kitScreen] as DesignScreen<unknown>[]) {
    for (const locale of LOCALES) {
      it(`${screen.screen} in ${locale}: ${screen.cases.length} cases, no key left, no secret, no money`, () => {
        for (const item of screen.cases) {
          const html = render(screen, item.model, locale)
          expect(html.length, item.id).toBeGreaterThan(300)
          expect(html.match(LEFT_KEY)?.[0] ?? null, `${screen.screen}/${item.id} (${locale})`).toBeNull()
          const text = html.replace(/<[^>]+>/g, ' ')
          expect(text.match(/(?<![-\w])\d{6}(?![-\w])|\b[0-9A-HJKMNP-TV-Z]{26}\b/)?.[0] ?? null, `${screen.screen}/${item.id}`).toBeNull()
          expect(text.match(/€|EUR\s?\d|\$\s?\d/)?.[0] ?? null, `${screen.screen}/${item.id}: money on the floor`).toBeNull()
        }
      })
    }
  }
})
