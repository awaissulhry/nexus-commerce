import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ApiError } from '../../../lib/api/errors'
import { LOCALES } from '../../../lib/i18n/locales'
import { CATALOGUE, messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import type { Rules } from './api'
import { designScreen } from './fixtures'
import { bundleHeld, changeProblem, draftOf, floorRulesCan, impactOf, planOf, readinessOf, StepUpCancelled, subjectBody, tabOf, withStepUp } from './model'
import { FloorRulesView } from './view/FloorRulesView'

const TOPS = [...new Set(Object.keys(CATALOGUE.en['floor-rules'] ?? {}).map((key) => key.split('.')[0]!))]
const LEFT_KEY = new RegExp(`(?:^|[\\s>"])(?:${TOPS.join('|')})\\.[a-zA-Z]+(?:\\.[a-zA-Z_]+)*`)
const draw = (model: unknown, locale: 'it' | 'en' = 'en') =>
  renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell', 'floor-rules', 'lists']) }, createElement(FloorRulesView, { model } as never)))

const BASIS = { kind: 'UNION_AGREEMENT' as const, reference: 'Accordo RSU 14/2026', recordedAt: '2026-10-12T13:20:00.000Z', recordedById: null, recordedByName: null }
const rules = (over: Partial<Rules> = {}): Rules => ({ scanSubject: 'WORKER', isDefault: false, legalBasis: BASIS, standardBundleSize: 12, version: 3, updatedAt: null, ...over })
const AFFECTED = { openWorkOrders: 4, workersActive: 36, workersNotAcknowledged: 2, devicesWithoutStation: 1 }

describe('Floor rules (SCR-074): the monitoring switch', () => {
  it('narrowing never asks a code, only the confirm; nothing changed applies nothing', () => {
    const current = rules()
    expect(planOf(current, draftOf(current))).toMatchObject({ action: null, held: null, changes: 0 })
    const narrow = planOf(current, { ...draftOf(current), subject: 'STATION' })
    expect(narrow).toMatchObject({ change: 'NARROW', action: 'scanSubject', confirm: true, stepUp: false, held: null })
    expect(subjectBody(current, { ...draftOf(current), subject: 'STATION' }, narrow)).toEqual({ scanSubject: 'STATION', version: 3 })
  })

  it('widening needs the basis and its reference, then a reason, and asks a fresh code', () => {
    const station = rules({ scanSubject: 'STATION', legalBasis: null })
    const empty = { subject: 'WORKER' as const, basisKind: '' as const, reference: '', reason: '' }
    expect(planOf(station, empty)).toMatchObject({ change: 'WIDEN', held: 'fr.held.basis', stepUp: true })
    expect(planOf(station, { ...empty, basisKind: 'UNION_AGREEMENT' }).held).toBe('fr.held.reference')
    expect(planOf(station, { ...empty, reference: 'Accordo' }).held).toBe('fr.held.basisKind')
    const withBasis = { ...empty, basisKind: 'UNION_AGREEMENT' as const, reference: ' Accordo RSU 14/2026 ' }
    expect(planOf(station, withBasis).held).toBe('fr.held.reason')
    const ready = planOf(station, { ...withBasis, reason: 'Accordo firmato.' })
    expect(ready).toMatchObject({ held: null, basisChanged: true, changes: 2 })
    expect(subjectBody(station, { ...withBasis, reason: ' Accordo firmato. ' }, ready)).toEqual({ scanSubject: 'WORKER', reason: 'Accordo firmato.', legalBasis: { kind: 'UNION_AGREEMENT', reference: 'Accordo RSU 14/2026' }, version: 3 })
    // A site with no rules yet names workers by default: recording the basis is the first write (no version).
    const fresh = rules({ isDefault: true, legalBasis: null, version: null })
    expect(planOf(fresh, draftOf(fresh))).toMatchObject({ action: null })
    expect(planOf(fresh, { ...draftOf(fresh), basisKind: 'NOT_REQUIRED', reference: 'Parere avv. Esempio, 2/10/2026' })).toMatchObject({ action: 'legalBasis', held: null, stepUp: false })
  })

  it('replacing the basis is its own call (no code); a reason or reference too long is held', () => {
    const current = rules()
    expect(planOf(current, { ...draftOf(current), reference: 'Accordo RSU 3/2027' })).toMatchObject({ action: 'legalBasis', stepUp: false, held: null })
    expect(planOf(current, { ...draftOf(current), reference: 'x'.repeat(201) }).held).toBe('fr.held.referenceLong')
    const station = rules({ scanSubject: 'STATION' })
    expect(planOf(station, { ...draftOf(station), subject: 'WORKER', reason: 'y'.repeat(501) }).held).toBe('fr.held.reasonLong')
  })

  it('says readiness and a change’s reach in counts, never a name', () => {
    expect(readinessOf({ rules: rules({ scanSubject: 'STATION', legalBasis: null }), affected: AFFECTED }, null)).toEqual({ ready: true, lines: [{ key: 'fr.status.station' }] })
    expect(readinessOf({ rules: rules({ legalBasis: null }), affected: AFFECTED }, null).ready).toBe(false)
    expect(readinessOf({ rules: rules(), affected: AFFECTED }, { workers: { active: 36, acknowledged: 35, notAcknowledged: 1 }, versions: [] }).lines[1]).toEqual({ key: 'fr.status.waiting', params: { count: 1 } })
    expect(impactOf('WORKER', 'STATION', AFFECTED).map((line) => line.key)).toEqual(['fr.impact.narrow', 'fr.impact.devices', 'fr.impact.openOrders', 'fr.impact.keep'])
    expect(impactOf('STATION', 'WORKER', AFFECTED).map((line) => line.key)).toEqual(['fr.impact.widen', 'fr.impact.notAcknowledged', 'fr.impact.openOrders', 'fr.impact.keep'])
    expect(impactOf('WORKER', 'WORKER', AFFECTED)).toEqual([])
  })

  it('asks the code only on a 403 stepUp and runs the call once more; a closed dialog stops it', async () => {
    let calls = 0
    const stepUp = new ApiError('step_up', 403, 'forbidden', 'Step up.', null, [{ path: 'stepUp', message: 'x' }])
    const answer = await withStepUp(
      async () => {
        calls += 1
        if (calls === 1) throw stepUp
        return 'done'
      },
      async () => undefined,
    )
    expect([answer, calls]).toEqual(['done', 2])
    await expect(withStepUp(async () => Promise.reject(stepUp), async () => Promise.reject(new StepUpCancelled()))).rejects.toBeInstanceOf(StepUpCancelled)
    await expect(withStepUp(async () => Promise.reject(new ApiError('conflict', 409, 'conflict', 'x')), async () => undefined)).rejects.toBeInstanceOf(ApiError)
  })

  it('words a refusal, the bundle size and the abilities', () => {
    expect(changeProblem(new ApiError('conflict', 409, 'conflict', 'x'))).toEqual({ key: 'fr.problem.changed', conflict: true })
    expect(changeProblem(new ApiError('invalid', 400, 'validation_failed', 'x', null, [{ path: 'body/legalBasis/reference', message: 'x' }])).key).toBe('fr.held.basis')
    expect(bundleHeld(12, 12)).toBe('fr.bundle.same')
    expect(bundleHeld(0, 12)).toBe('fr.bundle.range')
    expect(bundleHeld(501, 12)).toBe('fr.bundle.range')
    expect(bundleHeld(20, 12)).toBeNull()
    expect(floorRulesCan(['production.settings.view'])).toEqual({ view: true, manage: false, reasons: false, privacy: false })
    expect(tabOf('codes')).toBe('codes')
    expect(tabOf('offstandard')).toBe('rules')
  })
})

describe('SCR-074 draws every design case in both languages', () => {
  for (const locale of LOCALES) {
    it(`${designScreen.cases.length} cases in ${locale}: no key or placeholder left, no English buttons in Italian`, () => {
      for (const item of designScreen.cases) {
        const html = draw(item.model.model, locale)
        expect(html.length, item.id).toBeGreaterThan(200)
        expect(html.match(LEFT_KEY)?.[0] ?? null, `${item.id} (${locale})`).toBeNull()
        expect(/\{[a-zA-Z]+\}/.test(html), `${item.id} (${locale}) placeholder`).toBe(false)
        if (locale === 'it') expect(/>(Discard|Apply|Save|Cancel)</.test(html), item.id).toBe(false)
      }
    })
  }

  it('a viewer gets no field to change (the switch is shown, held) and the words of who changes it; no worker is named', () => {
    const supervisor = draw(designScreen.cases.find((item) => item.id === 'supervisor')!.model.model)
    expect(supervisor).not.toMatch(/<input(?![^>]*disabled)/)
    expect(supervisor).not.toContain('<select')
    expect(supervisor).toContain('Only the production manager or the Owner changes this.')
    // The notice is read as counts: the people list the API gives a manager is never drawn.
    expect(draw(designScreen.cases.find((item) => item.id === 'worker-basis')!.model.model)).toContain('Counts only: this page never names a worker.')
    expect(draw(designScreen.cases.find((item) => item.id === 'default-no-basis')!.model.model)).toContain('Not ready for floor work')
  })
})
