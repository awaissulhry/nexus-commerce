import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { operationMinutesView, waitingView } from '@nexus/factory-domain/product/minutes/contracts'
import { librarySettingsView } from '@nexus/factory-domain/product/routing-depth/contracts'
import type { DesignScreen } from '../../../../lib/design/design-screen'
import { LOCALES } from '../../../../lib/i18n/locales'
import { CATALOGUE, messagesFor } from '../../../../lib/i18n/messages'
import { I18nProvider } from '../../../../lib/i18n/provider'
import { designScreen as operationsScreen } from '../fixtures'
import { designScreen as operationScreen } from '../record/fixtures'
import { librarySettingsSchema } from './api'
import { demoMinutes, LIBRARY_SETTINGS, READER_ID, VERSIONS, WAITING } from './demo'
import {
  connectionsOf,
  decideHeld,
  minDayOf,
  previewOf,
  proposeBodyOf,
  proposeDraftOf,
  proposeHeld,
  proposeProblems,
  settingBodiesOf,
  settingDraftOf,
  settingProblems,
  settingsSaveHeld,
  smvCanOf,
  typedSmvHeld,
  versionState,
  waitingSelectHeld,
  type ProposeDraft,
} from './model'

/**
 * B-W2b-235 — the operation library's depth: the proposal's checks are factory-domain's minute rules, four eyes on a decision,
 * the typed SMV held while governed, the settings list, the API's answers as the domain shapes them, every key in both
 * languages, every W2b case drawn with no key left.
 */

describe('Propose SMV change', () => {
  const view = demoMinutes({ pending: false })
  const draft = (patch: Partial<ProposeDraft> = {}): ProposeDraft => ({ ...proposeDraftOf(view, 'it'), reason: 'Rilievo tempi.', effectiveFrom: '2026-11-12', ...patch })

  it('starts from the operation\'s own numbers and the first day it may apply from', () => {
    const start = proposeDraftOf(view, 'it')
    expect(start).toMatchObject({ basic: '5,5', personal: '5', fatigue: '4,5', delay: '3,2273', effectiveFrom: '2026-10-29', reason: '', replace: false })
    expect(minDayOf(view)).toBe('2026-10-29')
    // An approved version from a later day moves the first day.
    expect(minDayOf({ today: '2026-10-29', versions: [{ ...VERSIONS[2]!, status: 'APPROVED', effectiveFrom: '2026-11-05' }] })).toBe('2026-11-05')
  })

  it('shows the SMV the domain will store (comma or point), and what to fix', () => {
    expect(previewOf({ basic: '5,8', personal: '5', fatigue: '4,5', delay: '2,569' })).toEqual({ ok: true, minutes: { basicMinutes: '5.8', personalPct: '5', fatiguePct: '4.5', delayPct: '2.569', standardMinutes: '6.5' } })
    expect(previewOf({ basic: '', personal: '0', fatigue: '0', delay: '0' })).toEqual({ ok: false, problems: { basic: 'propose.problem.basicEmpty' } })
    expect(previewOf({ basic: '5', personal: '100', fatigue: 'x', delay: '0' })).toMatchObject({ ok: false, problems: { personal: 'propose.problem.allowance', fatigue: 'propose.problem.allowance' } })
  })

  it('refuses a past day, an empty reason and the numbers it has already', () => {
    expect(proposeProblems(draft({ effectiveFrom: '2026-10-01' }), view).effectiveFrom).toBe('propose.problem.dayPast')
    expect(proposeProblems(draft({ reason: '  ' }), view).reason).toBe('propose.problem.reason')
    expect(proposeProblems(draft(), view).same).toBe('propose.held.same')
    expect(proposeProblems(draft({ basic: '5,8', delay: '2,569' }), view)).toEqual({})
  })

  it('holds Send while a proposal waits, unless this one replaces it; the body names the one it replaces', () => {
    const waiting = demoMinutes()
    const next = draft({ basic: '6', delay: '1' })
    expect(proposeHeld(next, waiting, false)).toBe('propose.held.waiting')
    expect(proposeHeld({ ...next, replace: true }, waiting, false)).toBeNull()
    expect(proposeBodyOf({ ...next, replace: true }, waiting)).toMatchObject({ basicMinutes: '6', delayPct: '1', replaces: VERSIONS[0]!.id, effectiveFrom: '2026-11-12', source: 'TIME_STUDY' })
    expect(proposeBodyOf(next, view)).not.toHaveProperty('replaces')
    expect(proposeHeld(next, { ...view, may: { propose: false, decide: false } }, false)).toBe('propose.held.noRight')
    expect(proposeHeld(next, { ...view, operation: { ...view.operation, status: 'ARCHIVED' } }, false)).toBe('propose.held.archived')
    expect(proposeHeld(next, view, true)).toBe('held.busy')
  })
})

describe('the Minutes tab', () => {
  it('W1\'s typed SMV only while no approval governs it, no allowances build it and nothing waits', () => {
    expect(typedSmvHeld(demoMinutes({ governed: false }))).toBeNull()
    expect(typedSmvHeld(demoMinutes())).toBe('minutes.typed.governed')
    expect(typedSmvHeld({ governed: false, current: { ...demoMinutes().current }, pendingId: null })).toBe('minutes.typed.allowances')
    expect(typedSmvHeld({ governed: false, current: demoMinutes({ governed: false }).current, pendingId: 'x' })).toBe('minutes.typed.waiting')
  })

  it('four eyes: the proposer never decides; a role without the right neither', () => {
    const view = demoMinutes()
    const pending = VERSIONS[0]!
    expect(decideHeld(pending, view, READER_ID)).toBeNull()
    expect(decideHeld(pending, view, pending.proposedBy.id)).toBe('decide.held.own')
    expect(decideHeld(pending, { may: { propose: true, decide: false } }, READER_ID)).toBe('decide.held.noRight')
    expect(decideHeld(VERSIONS[2]!, view, READER_ID)).toBe('decide.held.notWaiting')
    expect(waitingSelectHeld(WAITING[0]!, READER_ID)).toBeNull()
    expect(waitingSelectHeld(WAITING[1]!, READER_ID)).toBe('decide.held.own')
    expect(waitingSelectHeld({ ...WAITING[0]!, mayDecide: false }, READER_ID)).toBe('decide.held.noRight')
  })

  it('a version in words: in force, waiting for its day, waiting for approval, rejected, replaced', () => {
    expect(VERSIONS.map((version) => versionState(version).key)).toEqual(['version.state.PROPOSED', 'version.state.REJECTED', 'version.state.inForce', 'version.state.SUPERSEDED'])
    expect(versionState({ status: 'APPROVED', inForce: false, waiting: true })).toEqual({ key: 'version.state.waiting', tone: 'info' })
  })

  it('the connections link only to a built page the role reads', () => {
    const pages = new Set(['/people/piecerates'])
    expect(connectionsOf('/w/X', pages, ['people.piecerates.view'])).toEqual({ pieceRates: { kind: 'page', href: '/w/X/people/piecerates' }, changes: { kind: 'notBuilt' } })
    expect(connectionsOf('/w/X', pages, []).pieceRates).toEqual({ kind: 'noRight' })
    // B-W2b-274: Changes & versions opens on its SMV changes, for a role that reads the changes.
    expect(connectionsOf('/w/X', new Set(['/products/changes']), ['product.changes.view']).changes).toEqual({ kind: 'page', href: '/w/X/products/changes?kind=smv' })
    expect(connectionsOf('/w/X', new Set(['/products/changes']), []).changes).toEqual({ kind: 'noRight' })
    expect(smvCanOf(['product.smv.propose', 'plant.view'])).toMatchObject({ propose: true, approve: false, machineClasses: true })
  })
})

describe('machine and stitch settings', () => {
  const stored = LIBRARY_SETTINGS.settings
  it('a draft says each setting in the page\'s language, and sends it back as the API stores it', () => {
    const drafts = stored.map((setting) => settingDraftOf(setting, 'it'))
    expect(drafts[0]).toMatchObject({ stitchesPerCm: '3,5', needle: '134 LR Nm 110', machineClassId: stored[0]!.machineClass!.id })
    expect(settingBodiesOf(drafts)[0]).toEqual({ machineClassId: stored[0]!.machineClass!.id, stitchType: '301', needle: '134 LR Nm 110', thread: 'Tkt 40', stitchesPerCm: '3.5', tension: 'Media', foot: 'Piedino a rullo', notes: null })
    expect(settingsSaveHeld(drafts, stored, false)).toBe('settings.held.same')
    expect(settingsSaveHeld([drafts[1]!, drafts[0]!], stored, false)).toBeNull()
  })
  it('each setting says something; stitches per cm above 0 with at most 2 decimals', () => {
    const blank = { key: 'n', machineClassId: '', stitchType: '', needle: '', thread: '', stitchesPerCm: '', tension: '', foot: '', notes: '' }
    expect(settingProblems([blank])[0]).toEqual({ row: 'settings.problem.empty' })
    expect(settingProblems([{ ...blank, stitchesPerCm: '0' }])[0]).toEqual({ stitchesPerCm: 'settings.problem.stitches' })
    expect(settingProblems([{ ...blank, stitchesPerCm: '3,555' }])[0]).toEqual({ stitchesPerCm: 'settings.problem.stitches' })
    expect(settingProblems([{ ...blank, stitchesPerCm: '3,55' }])[0]).toEqual({})
    expect(settingsSaveHeld([blank], stored, false)).toBe('settings.held.fix')
  })
})

describe('the answers as the API shapes them', () => {
  it('the made-up minutes, waiting list and settings parse with factory-domain\'s own contracts', () => {
    expect(() => operationMinutesView.parse(demoMinutes())).not.toThrow()
    expect(() => waitingView.parse({ versions: WAITING, count: WAITING.length })).not.toThrow()
    expect(librarySettingsView.parse(LIBRARY_SETTINGS)).toEqual(librarySettingsSchema.parse(LIBRARY_SETTINGS))
    expect(Object.keys(librarySettingsSchema.shape).sort()).toEqual(Object.keys(librarySettingsView.shape).sort())
  })
})

// ---- every key in both languages; every W2b case drawn with no key left ----------------------------------------------------------

const HERE = fileURLToPath(new URL('.', import.meta.url))
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sources(path)
    return /\.tsx?$/.test(entry.name) && !entry.name.includes('.vitest.') && entry.name !== 'demo.ts' ? [path] : []
  })
}
const PREFIXES = ['minutes', 'versions', 'version', 'pending', 'propose', 'decide', 'impact', 'conn', 'refused', 'notice', 'waiting', 'settings', 'menu', 'tab', 'held', 'source', 'run', 'revisionStatus']
const KEY = new RegExp(`['"\`]((?:${PREFIXES.join('|')})\\.[A-Za-z0-9_.]*[A-Za-z0-9_])['"\`]`, 'g')
const has = (locale: (typeof LOCALES)[number], key: string) => {
  const dictionary = CATALOGUE[locale]['products-operations-depth'] ?? {}
  return key in dictionary || (`${key}_one` in dictionary && `${key}_other` in dictionary)
}

describe('every key the depth names exists in it and en', () => {
  const depthKeys = sources(HERE).flatMap((file) => [...readFileSync(file, 'utf8').matchAll(KEY)].map((match) => match[1]!))
  // The W1 list and record speak the library's catalogue; their W2b words are `td(…)`.
  const viewKeys = [join(HERE, '../view/OperationsListView.tsx'), join(HERE, '../record/view/OperationRecordView.tsx')].flatMap((file) => [...readFileSync(file, 'utf8').matchAll(/\btd\(\s*'([\w.]+)'/g)].map((match) => match[1]!))
  const built = [
    ...['TIME_STUDY', 'PREDETERMINED', 'ESTIMATE'].map((source) => `source.${source}`),
    ...['PROPOSED', 'APPROVED', 'REJECTED', 'SUPERSEDED', 'inForce', 'waiting'].map((state) => `version.state.${state}`),
    ...['VERSION', 'ALLOWANCES', 'TYPED'].map((run) => `run.${run}`),
    ...['DRAFT', 'RELEASED', 'OBSOLETE'].map((status) => `revisionStatus.${status}`),
  ]
  const keys = [...new Set([...depthKeys, ...viewKeys, ...built])]
  for (const locale of LOCALES) {
    it(`products-operations-depth (${locale})`, () => {
      expect(keys.length).toBeGreaterThan(80)
      expect(keys.filter((key) => !has(locale, key))).toEqual([])
    })
  }
})

const LEFT_KEY = new RegExp(`\\b(?:${PREFIXES.join('|')})\\.[a-zA-Z]+(?:\\.[a-zA-Z_]+)*\\b`)
function render(screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(View, { model })))
}

describe('every W2b case draws in both languages with no key left on screen', () => {
  for (const screen of [operationsScreen, operationScreen] as DesignScreen<unknown>[]) {
    for (const locale of LOCALES) {
      const cases = screen.cases.filter((item) => item.id.startsWith('w2b-235'))
      it(`${screen.screen} in ${locale}: ${cases.length} W2b cases`, () => {
        expect(cases.length).toBeGreaterThan(8)
        for (const item of cases) {
          const html = render(screen, item.model, locale).replace(/https?:\/\/[^"\s<]+/g, '').replace(/\b(?:product|people|plant|quality)\.[a-z]+(?:\.[a-z]+)?\b/g, '')
          expect(html.match(LEFT_KEY)?.[0] ?? null, `${screen.screen}/${item.id} (${locale})`).toBeNull()
        }
      })
    }
  }

  it('the Minutes tab says the SMV and how it is built, and never offers the proposer a decision', () => {
    const minutes = operationScreen.cases.find((item) => item.id === 'w2b-235-minutes')!
    const html = render(operationScreen as DesignScreen<unknown>, minutes.model, 'en')
    expect(html).toContain('Changes need approval')
    expect(html).toContain('5.5 min + 12.7273 % = 6.2 min')
    expect(html).toContain('v3 · published')
    expect(html).toContain('Approve')
    const own = operationScreen.cases.find((item) => item.id === 'w2b-235-minutes-own')!
    const ownHtml = render(operationScreen as DesignScreen<unknown>, own.model, 'en')
    expect(ownHtml).toContain('You proposed this change: a second person decides it.')
    expect(ownHtml).not.toContain('>Approve<')
  })
})
