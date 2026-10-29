import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { HIDE_STATES as DOMAIN_HIDE_STATES } from '@nexus/factory-domain/inventory/issue/rules'
import { UNUSABLE_REASONS as DOMAIN_UNUSABLE } from '@nexus/factory-domain/planning/usable'
import { WORK_CENTRE_KINDS as DOMAIN_KINDS } from '@nexus/factory-domain/product/routing/operations'
import { WORK_ORDER_STATUSES as DOMAIN_STATUSES } from '@nexus/factory-domain/production/work-orders/machine'
import { CHECK_STATES as DOMAIN_CHECK_STATES, RELEASE_CHECKS as DOMAIN_CHECKS } from '@nexus/factory-domain/production/work-orders/release'
import { ApiError } from '../../../lib/api/errors'
import type { DesignScreen } from '../../../lib/design/design-screen'
import { LOCALES } from '../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { designScreen as listScreen } from '../work-orders/fixtures'
import { designScreen as recordScreen } from '../work-orders/record/fixtures'
import { designScreen as cuttingScreen } from '../work-orders/cutting/fixtures'
import { designScreen as bundlesScreen } from '../work-orders/bundles/fixtures'
import { designScreen as floorScreen } from '../wip/fixtures'
import { CHECK_STATES, HIDE_STATES, RELEASE_CHECKS, UNUSABLE_REASONS, WORK_CENTRE_KINDS, WORK_ORDER_STATUSES } from './api'
import { bundlesOf, canOf, cutLogOf, LIST_ROWS, releaseCheck, wipOf, workOrder } from './fixtures'
import {
  abilitiesOf,
  checkItems,
  correctHold,
  hideBar,
  nextStep,
  percentOf,
  progressPhrase,
  releaseRefusalCodes,
  reprintHold,
  sizeRunOf,
  viewFromAddress,
  viewQuery,
  waitingAt,
  workOrdersCsv,
  writeProblem,
} from './model'
import { createHeld, overOpen, NO_NEW_ORDER } from '../work-orders/list-model'

/**
 * The Production office screens (SCR-069 … SCR-073): the enum lists mirror factory-domain, the rules without a screen
 * (who may do what, the next step held with its reason, the release check in words, the size run's layers, the hides'
 * area bars, where a bundle waits, refusals in words, the CSV), and every design case drawn in it and en with no
 * message key left on screen. Figures by hand from the made-up fixtures.
 */

describe('the web mirrors factory-domain', () => {
  it('statuses, release checks and their states, unusable reasons, hide states and work centre kinds', () => {
    expect(WORK_ORDER_STATUSES).toEqual(DOMAIN_STATUSES)
    expect(RELEASE_CHECKS).toEqual(DOMAIN_CHECKS)
    expect(CHECK_STATES).toEqual(DOMAIN_CHECK_STATES)
    expect(UNUSABLE_REASONS).toEqual(DOMAIN_UNUSABLE)
    expect(HIDE_STATES).toEqual(DOMAIN_HIDE_STATES)
    expect(WORK_CENTRE_KINDS).toEqual(DOMAIN_KINDS)
  })
})

describe('who may do what (the API checks every call again)', () => {
  it('the production manager does everything here; the team leader and sales read', () => {
    expect(canOf('manager')).toMatchObject({ view: true, manage: true, release: true, correctCuts: true, bundles: true, printLabels: true, quality: true, pick: true })
    expect(canOf('teamLeader')).toMatchObject({ view: true, manage: false, release: false, correctCuts: false, bundles: false, quality: false, pick: false })
    expect(canOf('sales')).toMatchObject({ view: true, manage: false, release: false, orders: true, quality: false })
    expect(abilitiesOf([])).toMatchObject({ view: false, manage: false })
  })
})

describe('the band: the next step, held with its reason', () => {
  const manager = canOf('manager')
  it('a draft: held by its open checks; only a short material lets the planner release with a reason; no right: held', () => {
    expect(nextStep(workOrder('DRAFT'), manager, releaseCheck('blocked'), null)).toEqual({ kind: 'release', held: { key: 'held.checksOpen', params: { count: 4 } } })
    expect(nextStep(workOrder('DRAFT'), manager, releaseCheck('material'), null)).toEqual({ kind: 'release', held: null })
    expect(nextStep(workOrder('DRAFT'), manager, releaseCheck('ready'), null)).toEqual({ kind: 'release', held: null })
    expect(nextStep(workOrder('DRAFT'), canOf('sales'), releaseCheck('ready'), null).held).toEqual({ key: 'held.noRelease' })
    expect(nextStep(workOrder('DRAFT'), manager, null, null).held).toEqual({ key: 'held.checking' })
  })
  it('released → start; in progress → complete once every garment is finished (6 of 26 finished: 20 left); completed → close', () => {
    expect(nextStep(workOrder('RELEASED'), manager, null, null)).toEqual({ kind: 'start', held: null })
    expect(nextStep(workOrder('IN_PROGRESS'), manager, null, wipOf())).toEqual({ kind: 'complete', held: { key: 'held.notFinished', params: { count: 20 } } })
    expect(nextStep(workOrder('IN_PROGRESS'), manager, null, wipOf(true))).toEqual({ kind: 'complete', held: null })
    expect(nextStep(workOrder('COMPLETED'), manager, null, null)).toEqual({ kind: 'close', held: null })
    expect(nextStep(workOrder('CLOSED'), manager, null, null)).toEqual({ kind: null, held: null })
    expect(nextStep(workOrder('RELEASED'), canOf('teamLeader'), null, null).held).toEqual({ key: 'held.noManage' })
  })
})

describe('the release check in this app’s words (never the API’s sentences)', () => {
  it('each problem by where it is: the cell, the order, the material with its held stock, the kind of work centre', () => {
    const items = checkItems(releaseCheck('blocked'), workOrder('DRAFT'))
    const byCode = Object.fromEntries(items.map((item) => [item.code, item]))
    expect(byCode.REVISION!.words).toEqual({ key: 'check.REVISION.OK', params: expect.objectContaining({ revision: 3 }) })
    expect(byCode.CERTIFICATE!.problems).toEqual([{ key: 'problem.certificate', params: { cell: 'RED 52' } }])
    expect(byCode.DEPOSIT!.problems).toEqual([{ key: 'problem.deposit', params: { order: 'SO-DEMO-0042' } }])
    expect(byCode.WORK_CENTRES!.problems).toEqual([{ key: 'problem.workCentre', params: { kind: 'kind.FINISHING', site: 'STAB-N' } }])
    expect(byCode.MATERIAL!.problems).toEqual([
      { key: 'problem.material.short', params: { material: 'Pelle nappa demo ROSSO', short: '208.96', uom: 'FT2', needed: '288.96', available: '80.00' } },
      { key: 'problem.material.held', params: { quantity: '165.00', uom: 'FT2', reason: 'reason.CR_VI_PENDING' } },
    ])
    expect(byCode.BATCH_NUMBER!.problems).toEqual([])
  })
  it('a style without a released revision: the checks that follow from it say so, not a made-up cause', () => {
    const items = checkItems(releaseCheck('noRevision'), workOrder('DRAFT', { revision: null, labelTemplate: null }))
    const byCode = Object.fromEntries(items.map((item) => [item.code, item.words.key]))
    expect(byCode).toMatchObject({ REVISION: 'check.REVISION.none', LABEL_TEMPLATE: 'check.noRevision', BOM: 'check.noRevision', WORK_CENTRES: 'check.WORK_CENTRES.noSteps' })
    expect(items.every((item) => item.problems.length === 0)).toBe(true)
  })
  it('the release refusal names its checks by the issue paths', () => {
    const refused = new ApiError('conflict', 409, 'invalid_state', 'x', null, [{ path: 'orders/a/deposit' }, { path: 'materials/b/c' }, { path: 'cells/d/certificate' }, { path: 'checks/WORK_CENTRES/SEWING' }])
    expect(releaseRefusalCodes(refused).sort()).toEqual(['CERTIFICATE', 'DEPOSIT', 'MATERIAL', 'WORK_CENTRES'])
    expect(releaseRefusalCodes(new ApiError('forbidden', 403, 'forbidden', 'x'))).toEqual([])
  })
})

describe('the size run, a layer at a time', () => {
  it('quantity 26; finished 6 (2 + 2 + 2); still to finish 20; a draft counts nothing yet', () => {
    const wo = workOrder('IN_PROGRESS')
    const sum = (value: Record<string, Record<string, number>>) => Object.values(value).reduce((total, row) => total + Object.values(row).reduce((a, b) => a + b, 0), 0)
    expect(sum(sizeRunOf(wo, 'quantity').value)).toBe(26)
    expect(sum(sizeRunOf(wo, 'finished').value)).toBe(6)
    expect(sum(sizeRunOf(wo, 'balance').value)).toBe(20)
    expect(sizeRunOf(wo, 'cut').sizes.map((size) => size.key)).toEqual(['48', '50', '52', '54'])
    expect(sizeRunOf(wo, 'cut').colours.find((colour) => colour.key === 'RED')!.offered).toEqual(['50', '52'])
    expect(sizeRunOf(workOrder('DRAFT'), 'cut').uncounted).toBe(true)
  })
  it('the list phrases the furthest step counted; a draft is not released yet', () => {
    expect(progressPhrase(LIST_ROWS.find((row) => row.number === 'WO-00009')!)).toEqual({ key: 'progress.finished', params: { done: 6, total: 26 } })
    expect(progressPhrase(LIST_ROWS.find((row) => row.number === 'WO-00007')!)).toEqual({ key: 'progress.cut', params: { done: 12, total: 12 } })
    expect(progressPhrase(LIST_ROWS.find((row) => row.number === 'WO-00012')!)).toEqual({ key: 'progress.notFrozen' })
    expect(percentOf(6, 26)).toBe(23)
    expect(percentOf(null, 26)).toBeNull()
  })
})

describe('cutting: hides and corrections', () => {
  it('a hide’s area bar: cut 192.64 + waste 25.16 + returned 6.2 + left 0 = issued 224, whole percents adding to 100', () => {
    const bar = hideBar(cutLogOf().hides[1]!)
    expect(bar.parts.map((part) => [part.part, part.percent])).toEqual([
      ['cut', 86],
      ['waste', 11],
      ['returned', 3],
      ['left', 0],
    ])
    expect(bar.parts.reduce((sum, part) => sum + part.percent, 0)).toBe(100)
  })
  it('the office corrects a live cut; of a used-up hide only its closing cut; never a correction or a reversed entry', () => {
    const log = cutLogOf()
    const byN = (n: number) => log.entries.find((entry) => entry.id.endsWith(String(n).padStart(12, '0')))!
    const manager = canOf('manager')
    expect(correctHold(byN(3), log, manager)).toBeNull()
    expect(correctHold(byN(4), log, manager)).toBeNull()
    expect(correctHold({ ...byN(4), closing: false }, log, manager)).toBe('usedUp')
    expect(correctHold(byN(6), log, manager)).toBe('reversal')
    expect(correctHold(byN(5), log, manager)).toBe('reversed')
    expect(correctHold(byN(3), log, canOf('teamLeader'))).toBe('noRight')
    expect(correctHold(byN(3), { ...log, workOrder: { ...log.workOrder, status: 'COMPLETED' } }, manager)).toBe('notOpen')
  })
})

describe('bundles: where each waits, what may be reprinted', () => {
  const scanned = [10, 20, 30, 40, 50]
  it('the first scanned operation a bundle is not done at; done everywhere or void: none', () => {
    const [b1, , b3, , , b6, b7] = bundlesOf().bundles
    expect(waitingAt(b1!, scanned)).toBe(50)
    expect(waitingAt(b3!, scanned)).toBe(40)
    expect(waitingAt(b6!, scanned)).toBe(30)
    expect(waitingAt(b7!, scanned)).toBeNull()
    expect(waitingAt({ status: 'ACTIVE', doneAt: scanned, part: null }, scanned)).toBeNull()
  })
  it('a void bundle has no ticket; a work order out of production reprints nothing', () => {
    const [b1, , , , , , b7] = bundlesOf().bundles
    expect(reprintHold(b1!, 'IN_PROGRESS')).toBeNull()
    expect(reprintHold(b7!, 'IN_PROGRESS')).toBe('void')
    expect(reprintHold(b1!, 'COMPLETED')).toBe('notOpen')
  })
})

describe('refusals in words, addresses, the CSV, the new work order', () => {
  it('a cutting or bundle refusal by its code; a changed work order; no right; no answer', () => {
    expect(writeProblem(new ApiError('conflict', 409, 'invalid_state', 'x', null, [{ path: 'refusal/IN_BUNDLE' }]), 'cut')).toEqual({ key: 'refusal.cut.IN_BUNDLE' })
    expect(writeProblem(new ApiError('conflict', 409, 'invalid_state', 'x', null, [{ path: 'refusal/VOIDED' }]), 'bundle')).toEqual({ key: 'refusal.bundle.VOIDED' })
    expect(writeProblem(new ApiError('conflict', 409, 'version_conflict', 'x'))).toEqual({ key: 'error.changed' })
    expect(writeProblem(new ApiError('forbidden', 403, 'forbidden', 'x'))).toEqual({ key: 'error.forbidden' })
    expect(writeProblem(new ApiError('unavailable', 0, 'network', 'x'))).toEqual({ key: 'error.offline' })
    expect(writeProblem(new Error('x'))).toEqual({ key: 'error.write' })
  })
  it("the list's address: its own view, or the API list's query (Today's See all)", () => {
    const params = (query: string) => new URLSearchParams(query)
    expect(viewFromAddress(params(''))).toBe('open')
    expect(viewFromAddress(params('view=all'))).toBe('all')
    expect(viewFromAddress(params('status=DRAFT'))).toBe('DRAFT')
    expect(viewFromAddress(params('late=true'))).toBe('late')
    expect(viewFromAddress(params('status=NOPE'))).toBe('open')
    expect(viewQuery('open', ' wo ')).toMatchObject({ open: true, q: 'wo', limit: 50 })
    expect(viewQuery('RELEASED', '')).toMatchObject({ status: 'RELEASED', q: undefined })
  })
  it('the CSV quotes what needs it and leaves unknown counts empty', () => {
    const csv = workOrdersCsv([{ ...LIST_ROWS[0]!, styleName: 'Giacca, "demo"' }], { header: ['a', 'b'], status: (status) => `S:${status}` })
    const [, line] = csv.trim().split('\n')
    expect(line).toContain('"Giacca, ""demo"""')
    expect(line).toContain('S:DRAFT')
    expect(line).toContain(',,,,')
  })
  it('the new work order: never more than is open on a line; held with the reason until it can go', () => {
    const lines = [{ id: 'l1', seq: 1, kind: 'SIZE_GRID', styleId: 's', styleCode: 'S', styleName: 'S', colourwayId: 'c', colourwayCode: 'BLK', madeToMeasure: false, sizes: [{ size: '50', ordered: 4, onWorkOrders: 1, open: 3 }] }]
    expect(overOpen(lines, ['l1'], { l1: { '50': 4 } })).toEqual([{ lineId: 'l1', size: '50', open: 3 }])
    expect(overOpen(lines, ['l1'], { l1: { '50': 3 } })).toEqual([])
    const can = canOf('manager')
    expect(createHeld(NO_NEW_ORDER, can)).toEqual({ key: 'new.held.order' })
    expect(createHeld(NO_NEW_ORDER, canOf('sales'))).toEqual({ key: 'held.noManage' })
  })
})

const LEFT_KEY =
  /\b(?:list|tile|view|col|progress|bulk|csv|held|new|record|tab|step|action|part|overview|check|problem|reason|kind|kindOf|size|materials|cutting|hideState|correct|bundles|reprint|ops|quality|release|move|cancel|notice|error|refusal|floor|live|status|common)\.[a-zA-Z]+(?:\.[a-zA-Z_]+)*\b/

const PERMISSIONS = /\b(?:workorders\.(?:view|manage|release)|quality\.inspections\.view|production\.cut\.correct|production\.bundles|inventory\.issue|print\.labels|orders\.view)\b/g

function render(screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(View, { model })))
}

describe('every design case draws in both languages with no key left on screen', () => {
  for (const screen of [listScreen, recordScreen, cuttingScreen, bundlesScreen, floorScreen] as unknown as DesignScreen<unknown>[]) {
    it(`${screen.screen}: ${screen.cases.length} cases × it, en`, () => {
      for (const item of screen.cases) {
        for (const locale of LOCALES) {
          // Permission names are said on purpose ("needs quality.inspections.view"): not keys.
          const html = render(screen, item.model, locale).replace(PERMISSIONS, '')
          expect(html.length, `${screen.screen}/${item.id}`).toBeGreaterThan(200)
          expect(html.match(LEFT_KEY)?.[0] ?? null, `${screen.screen}/${item.id} (${locale})`).toBeNull()
        }
      }
    })
  }
  it('the dynamic words exist in both languages (status, checks × states, reasons, kinds, layers)', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['production']).production!)
      for (const status of WORK_ORDER_STATUSES) expect(t(`status.${status}`)).not.toBe(`status.${status}`)
      for (const reason of UNUSABLE_REASONS) expect(t(`reason.${reason}`)).not.toBe(`reason.${reason}`)
      for (const kind of WORK_CENTRE_KINDS) expect(t(`kind.${kind}`)).not.toBe(`kind.${kind}`)
      for (const state of HIDE_STATES) expect(t(`hideState.${state}`)).not.toBe(`hideState.${state}`)
      for (const code of RELEASE_CHECKS) expect(t(`check.name.${code}`)).not.toBe(`check.name.${code}`)
    }
  })
})
