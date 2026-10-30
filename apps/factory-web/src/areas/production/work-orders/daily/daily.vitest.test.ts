import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { RELEASE_CHECKS as HOLD_RELEASE_CHECKS } from '@nexus/factory-domain/quality/holds/rules'
import { READINESS_WORDS as DOMAIN_READINESS_WORDS } from '@nexus/factory-domain/planning/readiness/readiness'
import { SPLIT_REASONS as DOMAIN_SPLIT_REASONS } from '@nexus/factory-domain/production/bundles/split'
import type { DesignScreen } from '../../../../lib/design/design-screen'
import { LOCALES } from '../../../../lib/i18n/locales'
import { I18nProvider } from '../../../../lib/i18n/provider'
import { designScreen as listScreen } from '../fixtures'
import { designScreen as recordScreen } from '../record/fixtures'
import { designScreen as cuttingScreen } from '../cutting/fixtures'
import { designScreen as bundlesScreen } from '../bundles/fixtures'
import { designScreen as codesScreen } from '../../settings/codes/fixtures'
import { createTranslator, messagesFor } from '../../../../lib/i18n/messages'
import { READINESS_WORDS, WORK_ORDER_STATUSES } from '../../_shared/api'
import { SPLIT_REASONS } from './api'
import { AVAILABILITY, FINISHED, HOLD, HOLD_RECORD, heldWorkOrder, SCRAP, YIELD, demoCan } from './demo/fixtures'
import {
  beforeRelease,
  bulkHoldHeld,
  dailyCan,
  dailyProblem,
  finishHeld,
  finishRows,
  flowSteps,
  hideHeld,
  holdHeld,
  placeHeld,
  readinessView,
  releaseHoldHeld,
  reportCells,
  reportHeld,
  scrapGroups,
  scrapTotals,
  splitAskHeld,
  splitHeld,
  yieldBars,
} from './model'

/** B-W2a-46: the work order every day's rules (who may, why a button waits, how the parts read), and its words. */

const manager = demoCan('manager')
const nobody = dailyCan(['workorders.view'])

describe('who may do what (the role templates)', () => {
  it('gives the production manager holds, finished to stock, reserve and scrap; quality releases holds', () => {
    expect(manager).toMatchObject({ holdsView: true, holdsPlace: true, finish: true, reserve: true, scrapView: true, bundles: true })
    expect(manager.holdsRelease).toBe(false)
    expect(demoCan('quality').holdsRelease).toBe(true)
    expect(nobody).toMatchObject({ holdsView: false, holdsPlace: false, holdsRelease: false, finish: false, reserve: false, scrapView: false })
    // Reserving needs the stock read as well (the hides the dialog shows).
    expect(dailyCan(['inventory.reserve']).reserve).toBe(false)
  })
})

describe('holds', () => {
  it('holds an open work order, says why not otherwise', () => {
    expect(holdHeld({ status: 'IN_PROGRESS' }, manager)).toBeNull()
    expect(holdHeld({ status: 'DRAFT' }, manager)).toBeNull()
    expect(holdHeld({ status: 'ON_HOLD' }, manager)).toEqual({ key: 'held.alreadyHeld' })
    expect(holdHeld({ status: 'COMPLETED' }, manager)).toEqual({ key: 'held.notOpen', params: { status: 'status.COMPLETED' } })
    expect(holdHeld({ status: 'RELEASED' }, nobody)).toEqual({ key: 'held.noHoldPlace' })
    expect(bulkHoldHeld([{ status: 'RELEASED' }, { status: 'CLOSED' }], manager)).toEqual({ key: 'held.bulkNotOpen', params: { count: 1 } })
  })

  it('asks a reason, and the note a reason needs', () => {
    const reasons = [
      { id: '1', list: 'HOLD' as const, code: 'QUALITY_CHECK', labelIt: 'Controllo', labelEn: 'Check', labelI18n: {}, icon: null, colour: null, needsDetail: false, sortOrder: 10 },
      { id: '2', list: 'HOLD' as const, code: 'OTHER', labelIt: 'Altro', labelEn: 'Other', labelI18n: {}, icon: null, colour: null, needsDetail: true, sortOrder: 20 },
    ]
    expect(placeHeld('', '', null, false)).toEqual({ key: 'hold.held.reasons' })
    expect(placeHeld('', '', reasons, false)).toEqual({ key: 'hold.held.reason' })
    expect(placeHeld('OTHER', ' a ', reasons, false)).toEqual({ key: 'hold.held.note' })
    expect(placeHeld('OTHER', 'Wrong lining', reasons, false)).toBeNull()
    expect(placeHeld('QUALITY_CHECK', '', reasons, true)).toEqual({ key: 'held.busy' })
  })

  it('releases only with the right, not the placer, and the statement where it is asked', () => {
    const quality = demoCan('quality')
    expect(releaseHoldHeld(HOLD_RECORD, manager, false, true, false)).toEqual({ key: 'held.noHoldRelease' })
    expect(releaseHoldHeld(HOLD_RECORD, quality, false, true, false)).toEqual({ key: 'releaseHold.held.statement' })
    expect(releaseHoldHeld(HOLD_RECORD, quality, true, true, false)).toBeNull()
    expect(releaseHoldHeld({ ...HOLD_RECORD, release: { ...HOLD_RECORD.release, mayRelease: false } }, quality, true, true, false)).toEqual({ key: 'held.notPlacer' })
    expect(releaseHoldHeld({ ...HOLD_RECORD, hold: { ...HOLD, status: 'RELEASED' } }, quality, true, true, false)).toEqual({ key: 'held.holdNotActive' })
  })

  it('reads a held draft as before the release', () => {
    expect(beforeRelease(heldWorkOrder('DRAFT'))).toBe(true)
    expect(beforeRelease(heldWorkOrder('IN_PROGRESS'))).toBe(false)
  })
})

describe('report finished to stock', () => {
  it('waits for a released garment, a place, and never takes more than a size can', () => {
    expect(finishHeld({ status: 'IN_PROGRESS', kind: 'SIZE_GRID' }, FINISHED, manager)).toBeNull()
    expect(finishHeld({ status: 'ON_HOLD', kind: 'SIZE_GRID' }, FINISHED, manager)).toEqual({ key: 'held.onHold' })
    expect(finishHeld({ status: 'IN_PROGRESS', kind: 'REPAIR' }, FINISHED, manager)).toEqual({ key: 'held.repairNoStock' })
    expect(finishHeld({ status: 'IN_PROGRESS', kind: 'SIZE_GRID' }, { ...FINISHED, places: [] }, manager)).toEqual({ key: 'held.noFinishedPlace' })
    expect(finishHeld({ status: 'IN_PROGRESS', kind: 'SIZE_GRID' }, FINISHED, nobody)).toEqual({ key: 'held.noFinish' })
    const first = FINISHED.cells[0]!
    const rows = finishRows(FINISHED, { [first.cellId]: first.canReport + 1 })
    expect(rows[0]!.over).toBe(true)
    expect(reportHeld(rows, 'place', false)).toEqual({ key: 'finish.held.over' })
    const fine = finishRows(FINISHED, {})
    expect(reportHeld(fine, null, false)).toEqual({ key: 'finish.held.place' })
    expect(reportHeld(fine, 'place', false)).toBeNull()
    expect(reportCells(fine).reduce((sum, cell) => sum + cell.quantity, 0)).toBe(FINISHED.garments.canReport)
  })
})

describe('yield, scrap, the flow, reserve and split', () => {
  it('marks a hide below plan; groups scrap and rework per operation and reason', () => {
    const bars = yieldBars(YIELD)
    expect(bars.map((bar) => bar.low)).toEqual([false, true, false])
    const groups = scrapGroups(SCRAP, 'en')
    expect(groups.map((group) => [group.seq, group.kind, group.reasonCode, group.rows, group.pieces, group.open])).toEqual([
      [20, 'SCRAP', 'TORN', 2, 2, 0],
      [20, 'REWORK', 'SEAM', 1, 2, 2],
      [30, 'REWORK', 'ZIP', 1, 1, 0],
    ])
    expect(groups[0]!.reason).toBe('Torn leather')
    expect(scrapGroups(SCRAP, 'it')[0]!.reason).toBe('Pelle strappata')
    expect(scrapTotals(SCRAP)).toEqual({ scrap: 2, rework: 3, reworkOpen: 2 })
  })

  it('marks the biggest pile as the bottleneck (totals only)', () => {
    const steps = flowSteps({ operations: [{ seq: 10, code: 'A', name: 'a', waiting: 2, good: 5, scrap: 0, rework: 0, final: false }, { seq: 20, code: 'B', name: 'b', waiting: 7, good: 1, scrap: 1, rework: 0, final: true }] } as never)
    expect(steps.map((step) => step.bottleneck)).toEqual([false, true])
    expect(flowSteps(null)).toEqual([])
  })

  it('lets a reserve take only free hides, saying why not', () => {
    const wo = AVAILABILITY.hides[2]!.reservedFor!.id
    expect(AVAILABILITY.hides.map((hide) => hideHeld(hide, wo))).toEqual([null, null, 'reserve.why.mine', 'reserve.why.other', 'reserve.why.held'])
  })

  it('splits 1 … n − 1 garments of an active bundle of an open work order, with a reason', () => {
    expect(splitHeld({ status: 'ACTIVE', quantity: 6 }, 'IN_PROGRESS', manager)).toBeNull()
    expect(splitHeld({ status: 'ACTIVE', quantity: 1 }, 'IN_PROGRESS', manager)).toEqual({ key: 'held.bundleOne' })
    expect(splitHeld({ status: 'VOID', quantity: 6 }, 'IN_PROGRESS', manager)).toEqual({ key: 'held.bundleVoid' })
    expect(splitHeld({ status: 'ACTIVE', quantity: 6 }, 'ON_HOLD', manager)).toEqual({ key: 'held.onHold' })
    expect(splitAskHeld(6, { quantity: 6 }, 'REWORK', false)).toEqual({ key: 'split.held.quantity', params: { max: 5 } })
    expect(splitAskHeld(2, { quantity: 6 }, '', false)).toEqual({ key: 'split.held.reason' })
    expect(splitAskHeld(2, { quantity: 6 }, 'HOLD', false)).toBeNull()
  })

  it('reads a released work order\'s readiness with the spec\'s labels', () => {
    const wo = heldWorkOrder()
    const view = readinessView(wo, null, { workOrderId: wo.id, word: 'EXPECTED', date: '2026-11-04', open: 0, materials: [{ itemId: wo.spec.materials[0]!.itemId, itemColourId: wo.spec.materials[0]!.itemColourId, word: 'EXPECTED', date: '2026-11-04' }], asOf: '2026-10-30' })
    expect(view).toMatchObject({ word: 'EXPECTED', materials: [{ label: 'PEL-NAPPA-NERO NERO', uom: 'FT2' }] })
    expect(readinessView(wo, null, null)).toBeNull()
  })

  it('says a refused write in its own words', () => {
    expect(dailyProblem({ kind: 'conflict' })).toEqual({ key: 'problem.conflict' })
    expect(dailyProblem(new Error('x'))).toEqual({ key: 'problem.write' })
  })
})

describe('the words (production-work-orders.json)', () => {
  it.each(LOCALES)('has every dynamic key in %s', (locale) => {
    const t = createTranslator(locale, messagesFor(locale, ['production-work-orders'])['production-work-orders']!)
    const keys = [
      ...READINESS_WORDS.map((word) => `readiness.${word}`),
      ...READINESS_WORDS.map((word) => `readiness.hint.${word}`),
      ...WORK_ORDER_STATUSES.map((status) => `status.${status}`),
      ...HOLD_RELEASE_CHECKS.flatMap((key) => [`releaseHold.check.${key}.ok`, `releaseHold.check.${key}.open`]),
      ...SPLIT_REASONS.flatMap((reason) => [`split.reasons.${reason}`, `split.reasons.${reason}Hint`]),
      'scrap.kind.SCRAP',
      'scrap.kind.REWORK',
      'yield.planned.STYLE',
      'yield.planned.BOM',
      ...['pick', 'cutting'].flatMap((what) => [`print.${what}.button`, `print.${what}.title`, `print.${what}.heading`, `print.${what}.foot`]),
      ...['wrong', 'locked', 'unavailable'].map((key) => `stepUp.problem.${key}`),
      'releaseHold.stepUpSentence',
    ]
    for (const key of keys) expect(t(key, { count: 1, date: 'x', number: 'x' }), key).not.toBe(key)
  })

  it('mirrors the domain lists it says', () => {
    expect(READINESS_WORDS).toEqual(DOMAIN_READINESS_WORDS)
    expect(SPLIT_REASONS).toEqual(DOMAIN_SPLIT_REASONS)
  })
})

// ---- the W2a design cases draw in both languages with no key of their own left on screen ------------------------------------

const W2A_KEY = /\b(?:readiness|holds|hold|releaseHold|finished|finish|yield|scrap|flow|reserve|split|print|held|notice|problem|stepUp|status|part|bundles|check)\.[a-zA-Z]+(?:\.[a-zA-Z_]+)*\b/
const PERMISSION_WORDS = /\b(?:quality\.holds\.(?:view|place|release)|production\.(?:finish|scrap\.view|bundles)|inventory\.(?:reserve|stock\.view|issue)|reasons\.view|workorders\.(?:view|manage|release))\b/g

function renderCase(screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(View, { model })))
}

describe('every W2a design case draws in both languages with no key left on screen', () => {
  for (const screen of [listScreen, recordScreen, cuttingScreen, bundlesScreen, codesScreen] as unknown as DesignScreen<unknown>[]) {
    const cases = screen.cases.filter((item) => item.id.startsWith('w2a-') || screen.screen === 'SCR-088')
    it(`${screen.screen}: ${cases.length} W2a cases × it, en`, () => {
      expect(cases.length).toBeGreaterThan(0)
      for (const item of cases) {
        for (const locale of LOCALES) {
          const html = renderCase(screen, item.model, locale).replace(PERMISSION_WORDS, '')
          expect(html.length, `${screen.screen}/${item.id}`).toBeGreaterThan(200)
          expect(html.match(W2A_KEY)?.[0] ?? null, `${screen.screen}/${item.id} (${locale})`).toBeNull()
        }
      }
    })
  }
})
