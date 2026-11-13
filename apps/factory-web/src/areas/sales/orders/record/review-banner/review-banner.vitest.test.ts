import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MTM_LINE_CODES } from '@nexus/factory-domain/sales/mtm/codes'
import { REVIEW_STATUSES } from '@nexus/factory-domain/sales/mtm/rules'
import type { DesignScreen } from '../../../../../lib/design/design-screen'
import { LOCALES } from '../../../../../lib/i18n/locales'
import { CATALOGUE, createTranslator, messagesFor } from '../../../../../lib/i18n/messages'
import { I18nProvider } from '../../../../../lib/i18n/provider'
import { isMtmCode, mtmFixItem, profileHref, type FixUnit } from '../../../../_shared/document-send/fix-tab/mtm/model'
import { designScreen as fixScreen } from '../../../../_shared/document-send/fix-tab/mtm/fixtures'
import { pickedAfter } from '../../../../production/work-orders/list-model'
import { designScreen as remakeScreen } from '../../../returns/outcome-remake/fixtures'
import { mayMakeRemake, remakeHeld, remakePartOf, remakeProblem } from '../../../returns/outcome-remake/model'
import type { RemakeView } from '../../../returns/outcome-remake/api'
import type { DocumentUnits } from '../../../mtm/api'
import { designScreen as bannerScreen } from './fixtures'
import { asksUnits, bannerProblem, NAMESPACE, reviewBannerOf } from './model'

/**
 * The made-to-measure follow-ups on screen (B-W2b-368): the order's "Waits for the factory review" (XF1:02), the send dialog's fix
 * for the MTM_* line checks (XF1:04), the remake as a return outcome (XF1:03) and a unit ticked alone on New work order (XF1:01):
 * the rules, the words of every code and state in both languages, and every design case drawn with no key on screen.
 */

const words = (locale: (typeof LOCALES)[number]) => CATALOGUE[locale][NAMESPACE] ?? {}
const unit = (review: 'WAITING' | 'NEED_MORE' | 'CONFIRMED', findings: DocumentUnits['units'][number]['findings'] = []): DocumentUnits['units'][number] => ({
  lineId: `line-${review}`,
  seq: 10,
  style: { id: 's', code: 'JKT' },
  colourway: { id: 'c', code: 'BLK' },
  baseSize: '52',
  profile: { id: `profile-${review}`, riderName: 'Rider', garmentType: 'JACKET', revision: 2, latestRevision: 2, review, takenAt: '2026-11-01T10:00:00.000Z' },
  verdict: 'WARN',
  suggestedBaseSize: null,
  insideCertifiedRange: null,
  findings,
})

describe('the order waits for the factory review (XF1:02)', () => {
  it('asks the units only for a waiting order with a unit', () => {
    expect(asksUnits({ status: 'PENDING_APPROVAL', lines: [{ kind: 'SIZE_GRID' }, { kind: 'MADE_TO_MEASURE' }] })).toBe(true)
    expect(asksUnits({ status: 'CONFIRMED', lines: [{ kind: 'MADE_TO_MEASURE' }] })).toBe(false)
    expect(asksUnits({ status: 'PENDING_APPROVAL', lines: [{ kind: 'SIZE_GRID' }] })).toBe(false)
  })

  it('names each unit still waiting with its review; held without the right to see measurements; the off state in words', () => {
    const answer = { waitsForReview: true, units: [unit('WAITING'), unit('CONFIRMED'), unit('NEED_MORE', [{ code: 'MTM_NOT_STARTED', severity: 'BLOCKS', message: 'x' }])] }
    const shown = reviewBannerOf(answer, ['orders.view', 'sales.measurements.view'], '/w/A')
    expect(shown.state === 'ready' && shown.waits && shown.units.map((entry) => [entry.lineId, entry.review.key, entry.href, entry.off?.key ?? null])).toEqual([
      ['line-WAITING', 'banner.review.WAITING', '/w/A/sales/made-to-measure/profile-WAITING?do=review', null],
      ['line-NEED_MORE', 'banner.review.NEED_MORE', '/w/A/sales/made-to-measure/profile-NEED_MORE?do=review', 'banner.off'],
    ])
    const held = reviewBannerOf(answer, ['orders.view'], '/w/A')
    expect(held.state === 'ready' && held.waits && held.units.every((entry) => entry.href === null && entry.held?.key === 'banner.held.right')).toBe(true)
    expect(reviewBannerOf({ waitsForReview: false, units: [unit('WAITING')] }, [], '/w/A')).toEqual({ state: 'ready', waits: false })
    expect(bannerProblem('forbidden').key).toBe('banner.problem.forbidden')
    expect(bannerProblem(null).key).toBe('banner.problem.internal')
  })

  it('has the words of every review state the banner shows', () => {
    for (const locale of LOCALES) for (const status of REVIEW_STATUSES.filter((entry) => entry !== 'CONFIRMED')) expect(words(locale)[`banner.review.${status}`], `${locale} ${status}`).toBeTruthy()
  })
})

describe('the send dialog’s fix for the MTM line checks (XF1:04)', () => {
  const units: FixUnit[] = [{ lineId: 'l1', seq: 10, profile: { id: 'p1', riderName: 'Rider', garmentType: 'JACKET', revision: 1, latestRevision: 3 } }]
  it('says each code in words of its unit and opens the rider profile; no unit or no right: no link', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, words(locale))
      for (const code of MTM_LINE_CODES) {
        expect(isMtmCode(code)).toBe(true)
        const item = mtmFixItem({ code, severity: 'BLOCKS', lineId: 'l1' }, 0, units, t, '/w/A', true)
        expect(item.label, `${locale} ${code}`).not.toContain('fix.')
        expect(item.fix).toEqual({ label: t('fix.open'), href: profileHref('/w/A', 'p1') })
        expect(mtmFixItem({ code, severity: 'WARNING', lineId: 'l1' }, 0, null, t, '/w/A', true)).toMatchObject({ state: 'warning', fix: null, label: t(`fix.general.${code}`) })
        expect(mtmFixItem({ code, severity: 'WARNING', lineId: 'l1' }, 0, units, t, '/w/A', false).fix).toBeNull()
      }
    }
    expect(isMtmCode('CERTIFICATE')).toBe(false)
  })
})

describe('a remake as a return outcome (XF1:03)', () => {
  const view = (over: Partial<RemakeView['lines'][number]> = {}, status = 'RECEIVED'): RemakeView => ({
    returnId: 'r',
    number: 'RMA-1',
    status,
    version: 3,
    lines: [{ lineId: 'l1', seq: 10, description: 'x', disposition: 'REMAKE', goodsOutcome: 'SCRAP', unit: { orderLineId: 'o', orderId: 'so', orderNumber: 'SO-1', seq: 10, style: 'JKT', colourway: 'BLK', baseSize: '52', madeTo: { id: 'p1', revision: 1, review: 'CONFIRMED' }, newest: { id: 'p2', revision: 2, review: 'WAITING' }, started: true }, remakeOrder: null, held: null, ...over }],
    outcomes: ['SCRAP', 'QUARANTINE'],
    may: { order: true },
    why: null,
  })
  const ALL = ['sales.returns.decide', 'orders.manage', 'sales.measurements.view']
  const facts = { permissions: ALL, offline: false, busy: false }

  it('holds Make the remake order with its reason from the facts', () => {
    const line = view().lines[0]!
    expect(remakeHeld(view(), line, facts)).toBeNull()
    expect(mayMakeRemake(ALL.slice(0, 2))).toBe(false)
    expect(remakeHeld(view(), line, { ...facts, permissions: ALL.slice(0, 2) })?.key).toBe('remake.held.right')
    expect(remakeHeld(view(), { ...line, unit: { ...line.unit!, started: false } }, facts)?.key).toBe('remake.held.off')
    expect(remakeHeld(view(), { ...line, disposition: null }, facts)?.key).toBe('remake.held.decide')
    expect(remakeHeld(view({}, 'CLOSED'), line, facts)?.key).toBe('remake.held.status')
    expect(remakeHeld(view(), line, { ...facts, offline: true })?.key).toBe('remake.held.offline')
    expect(remakeProblem('conflict').key).toBe('remake.problem.moved')
  })

  it('draws a line drafted or decided Remake only: its unit, the newest revision and its review, or the remake order', () => {
    const base = { ...facts, disposition: 'REMAKE', prefix: '/w/A' }
    expect(remakePartOf(view(), null, 'l1', { ...base, disposition: 'CREDIT_ONLY' })).toBeNull()
    expect(remakePartOf(null, null, 'l1', base)).toEqual({ state: 'loading' })
    expect(remakePartOf(view({ unit: null }), null, 'l1', base)).toMatchObject({ state: 'notUnit', words: { key: 'remake.notUnit' } })
    expect(remakePartOf(view(), null, 'l1', base)).toMatchObject({ state: 'unit', remakeTo: { key: 'remake.remakeToNewer', params: { revision: 2 } }, review: { key: 'remake.review.WAITING' }, order: null, held: null })
    const made = remakePartOf(view({ remakeOrder: { orderId: 'so-9', number: 'SO-9', orderLineId: 'ol', profileId: 'p2', status: 'PENDING_APPROVAL' } }), null, 'l1', base)
    expect(made).toMatchObject({ order: { number: 'SO-9', href: '/w/A/sales/orders/so-9', waits: true }, held: null })
  })
})

describe('a made-to-measure unit is ticked alone on New work order (XF1:01)', () => {
  const lines = [
    { id: 'grid', madeToMeasure: false },
    { id: 'unit', madeToMeasure: true },
    { id: 'grid2', madeToMeasure: false },
  ] as unknown as Parameters<typeof pickedAfter>[0]
  it('ticking the unit leaves it alone; ticking a size grid leaves the unit out', () => {
    expect(pickedAfter(lines, ['grid', 'grid2'], 'unit', true)).toEqual(['unit'])
    expect(pickedAfter(lines, ['unit'], 'grid', true)).toEqual(['grid'])
    expect(pickedAfter(lines, ['grid'], 'grid2', true)).toEqual(['grid', 'grid2'])
    expect(pickedAfter(lines, ['grid', 'grid2'], 'grid', false)).toEqual(['grid2'])
  })
})

const LEFT_KEY = /\b(?:banner|fix|remake|wait|check|problem|held|decide|inspect|new)\.[a-zA-Z_]+(?:\.[a-zA-Z_]+)*\b/

function render(screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(View, { model })))
}

describe('every design case draws in both languages with no key left on screen', () => {
  for (const screen of [bannerScreen, fixScreen, remakeScreen] as DesignScreen<unknown>[]) {
    for (const locale of LOCALES) {
      it(`${screen.screen} in ${locale}: ${screen.cases.length} cases`, () => {
        for (const item of screen.cases) {
          const html = render(screen, item.model, locale)
            .replace(/https?:\/\/[^"\s<]+/g, '')
            .replace(/data:[^"]+/g, '')
            .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '')
            .replace(/\b[\w-]+\.(?:pdf|png|jpg)\b/g, '')
          expect(html.match(LEFT_KEY)?.[0] ?? null, `${screen.screen}/${item.id} (${locale})`).toBeNull()
        }
      })
    }
  }

  it('the banner says it, with the review linked, and nothing for a confirmed order', () => {
    const html = (id: string) => render(bannerScreen as DesignScreen<unknown>, bannerScreen.cases.find((entry) => entry.id === id)!.model, 'en')
    expect(html('waiting')).toContain('Waits for the factory review')
    expect(html('waiting')).toContain('Open the review')
    // The yes banner (B-W2b-323's region) stays away while only the factory review holds the order; with the credit it is there.
    expect(html('waiting')).not.toContain('fw-sod-wait')
    expect(html('credit-too')).toContain('fw-sod-wait')
    expect(html('credit-too')).toContain('The factory review of a made-to-measure unit’s measures')
    expect(html('confirmed')).not.toContain('Waits for the factory review')
  })
})
