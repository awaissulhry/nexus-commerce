import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import * as domain from '@nexus/factory-domain/quality/plans/rules'
import * as triggers from '@nexus/factory-domain/quality/triggers/rules'
import { PROFILE_CODE as DOMAIN_PROFILE_CODE } from '@nexus/factory-domain/quality/aql/profiles'
import { samplingPlan } from '@nexus/factory-domain/quality/aql/sampling'
import type { DesignScreen } from '../../../lib/design/design-screen'
import { LOCALES } from '../../../lib/i18n/locales'
import { messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import en from '../../../../messages/en/quality-plans.json'
import enAql from '../../../../messages/en/quality-aql.json'
import { derivation, notesOf } from '../_shared/aql/aql-words'
import * as constants from './constants'
import { MARTA, PLAN_ROWS, PROFILES, RECORD, RECORD_APPROVED, RULES_ANSWER, VERSION_V2 } from './demo/fixtures'
import { designScreen as pageScreen } from './fixtures'
import {
  addressOf,
  appliesBody,
  appliesChanges,
  appliesDraftOf,
  approveHeld,
  bandPrimary,
  checkBody,
  checksProblems,
  chipsProblems,
  editHeld,
  newCheck,
  plansCan,
  printAskOf,
  problemOf,
  profileChanges,
  profileDraftOf,
  profilePlan,
  profilesProblems,
  queryOf,
  ruleDraftOf,
  ruleProblems,
  rulesChanges,
  rulesPlan,
  samplingBody,
  samplingDraftOf,
  samplingProblems,
  versionChanges,
  versionDraftOf,
  withType,
  type CheckDraft,
  type SamplingDraft,
} from './model'
import { designScreen as printScreen } from './print/fixtures'
import { designScreen as recordScreen } from './record/fixtures'
import { ApiError } from '../../../lib/api/errors'

// The DS Modal opens in a portal after mount (nothing on a server render): drawn in place, so every dialog's words are
// rendered and checked too.
vi.mock('@nexus/ui/components', async (original) => {
  const actual = await original<typeof import('@nexus/ui/components')>()
  const Modal = ({ open, title, children, footer }: { open: boolean; title?: unknown; children?: unknown; footer?: unknown }) =>
    open ? createElement('section', { 'data-modal': 'open' }, createElement('h2', null, title as never), children as never, footer as never) : null
  return { ...actual, Modal }
})

const ALL = { owner: ['quality.plans.view', 'quality.plans.manage', 'quality.plans.approve', 'quality.aql.view', 'quality.aql.manage', 'quality.triggers.view', 'quality.triggers.manage'] }

describe('the lists written for the browser are the domain’s (its rule files reach node:crypto)', () => {
  it('stages, statuses, check types, sampling, frequencies, chips, categories, codes, limits, events, record kinds', () => {
    expect(constants.PLAN_STAGES).toEqual(domain.PLAN_STAGES)
    expect(constants.VERSION_STATUSES).toEqual(domain.VERSION_STATUSES)
    expect(constants.CHECK_TYPES).toEqual(domain.CHECK_TYPES)
    for (const type of constants.CHECK_TYPES) expect(constants.takesResult(type), type).toBe(domain.takesResult(type))
    expect(constants.SAMPLING_METHODS).toEqual(domain.SAMPLING_METHODS)
    expect(constants.FREQUENCIES).toEqual(domain.FREQUENCIES)
    expect(constants.CHIP_KINDS).toEqual(domain.CHIP_KINDS)
    expect(constants.CATEGORY_CODES).toEqual(domain.CATEGORY_CODES)
    expect(Object.keys(domain.CATEGORY_WORDS).sort()).toEqual([...constants.CATEGORY_CODES].sort())
    expect(constants.PLAN_CODE.source).toBe(domain.PLAN_CODE.source)
    expect(constants.CHECK_CODE.source).toBe(domain.CHECK_CODE.source)
    expect(constants.MEASURE.source).toBe(domain.MEASURE.source)
    expect(constants.PROFILE_CODE.source).toBe(DOMAIN_PROFILE_CODE.source)
    for (const [name, value] of Object.entries(constants.PLAN_LIMITS)) expect(value, name).toBe(domain.PLAN_LIMITS[name as keyof typeof domain.PLAN_LIMITS])
    expect(constants.TRIGGER_EVENTS).toEqual(triggers.TRIGGER_EVENTS)
    expect(constants.RECORD_KINDS).toEqual(triggers.RECORD_KINDS)
    for (const stage of constants.PLAN_STAGES) for (const frequency of constants.FREQUENCIES) expect(constants.recordKindOf(stage, frequency), `${stage} ${frequency}`).toBe(triggers.recordKindOf(stage, frequency))
    for (const frequency of constants.FREQUENCIES) expect(constants.FREQUENCY_TAKES_VALUE[frequency], frequency).toBe(frequency === 'PERCENT_OF_OPERATIONS' || frequency === 'EVERY_NTH_BUNDLE')
  })
})

const draft = (over: Partial<CheckDraft>): CheckDraft => ({ ...newCheck([], 1), labelIt: 'Marcatura', labelEn: 'Mark', ...over })
const paths = (issues: readonly { path: string }[]) => issues.map((issue) => issue.path).sort()

describe('the builder’s problems are the domain’s, at the API’s paths', () => {
  const lists: CheckDraft[][] = [
    [draft({})],
    [draft({ code: 'bad code' }), draft({ code: 'CHECK_1' })],
    [draft({ code: 'A1' }), draft({ code: 'A1', labelIt: '', labelEn: '' })],
    [draft({ type: 'MEASUREMENT', nominal: '58', tolerance: '' })],
    [draft({ type: 'MEASUREMENT', nominal: '5x', tolerance: '1.0000' })],
    [draft({ type: 'MEASUREMENT', nominal: '', tolerance: '' })],
    [draft({ type: 'CHOICE', choices: ['Yes'] })],
    [draft({ type: 'CHOICE', choices: ['Yes', 'yes', ''] })],
    [withType(draft({ mandatory: true, photoRequired: true, checkClass: 'CRITICAL' }), 'INSTRUCTION')],
    [draft({ labelIt: 'x'.repeat(201) })],
  ]
  for (const [index, list] of lists.entries()) {
    it(`list ${index + 1}`, () => {
      expect(paths(checksProblems(list))).toEqual(paths(domain.checksProblems(list.map((check) => ({ ...checkBody(check), uom: checkBody(check).uom as domain.CheckDraft['uom'] })))))
    })
  }

  const samplings: SamplingDraft[] = [
    { method: 'AQL_PROFILE', profileId: null, fixedSize: '', frequency: null, frequencyValue: '', stop: 'SETTING' },
    { method: 'FIXED', profileId: null, fixedSize: '', frequency: null, frequencyValue: '', stop: 'STOP' },
    { method: 'FIXED', profileId: null, fixedSize: 20_000, frequency: 'PERCENT_OF_OPERATIONS', frequencyValue: 101, stop: 'FINISH' },
    { method: 'AQL_PROFILE', profileId: null, fixedSize: '', frequency: 'EVERY_NTH_BUNDLE', frequencyValue: '', stop: 'SETTING' },
    { method: 'AQL_PROFILE', profileId: null, fixedSize: '', frequency: 'FIRST_PIECE', frequencyValue: 3, stop: 'SETTING' },
  ]
  for (const [index, sampling] of samplings.entries()) {
    it(`sampling ${index + 1}`, () => {
      expect(paths(samplingProblems(sampling))).toEqual(paths(domain.samplingProblems(samplingBody(sampling))))
    })
  }

  it('a version round-trips: no change counts nothing, and its body is what was read', () => {
    const version = versionDraftOf(VERSION_V2)
    expect(versionChanges(VERSION_V2, version)).toBe(0)
    expect(samplingBody(samplingDraftOf(VERSION_V2.sampling))).toEqual({ samplingMethod: 'AQL_PROFILE', aqlProfileId: null, fixedSampleSize: null, frequency: null, frequencyValue: null, stopAtReject: true })
    const moved = { ...version, checks: [version.checks[1]!, version.checks[0]!, ...version.checks.slice(2)] }
    expect(versionChanges(VERSION_V2, moved)).toBe(1)
    const changed = { ...version, checks: [{ ...version.checks[0]!, labelEn: 'CE mark' }, ...version.checks.slice(1, 5), newCheck(version.checks, 9)], changeNote: version.changeNote }
    // One changed, one removed (READ), one added.
    expect(versionChanges(VERSION_V2, changed)).toBe(3)
    expect(checksProblems(version.checks)).toEqual([])
  })

  it('chips: a category from the list, each chip once', () => {
    const chips = [
      { kind: 'CATEGORY' as const, value: 'JACKET', label: '' },
      { kind: 'CATEGORY' as const, value: 'JACKET', label: '' },
      { kind: 'CATEGORY' as const, value: 'PLANES', label: '' },
    ]
    expect(paths(chipsProblems(chips))).toEqual(paths(domain.chipsProblems(chips.map(({ kind, value }) => ({ kind, value })))))
  })
})

describe('the addresses', () => {
  it('settings page: tabs, filters, New plan, the calculator — only what differs from the defaults', () => {
    const address = addressOf(new URLSearchParams('tab=calculator&lot=50&level=S3&major=1.5&minor=2.5&aql=p1'))
    expect(address.calc).toEqual({ lot: 50, level: 'S3', profile: 'p1', major: '1.5', minor: '2.5' })
    expect(queryOf(address)).toBe('?tab=calculator&lot=50&aql=p1&level=S3&major=1.5&minor=2.5')
    expect(queryOf(addressOf(new URLSearchParams('stage=FINAL&status=DRAFT&q=jacket&new=1')))).toBe('?stage=FINAL&status=DRAFT&q=jacket&new=1')
    expect(addressOf(new URLSearchParams('tab=nope&stage=MOON&lot=0&level=IV&major=3')).tab).toBe('plans')
    expect(addressOf(new URLSearchParams('lot=0&level=IV&major=3')).calc).toEqual({ lot: 500, level: 'II', profile: null, major: '2.5', minor: '4.0' })
    expect(addressOf(new URLSearchParams('copy=v1')).newPlan).toBe(true)
  })

  it('print: the plans asked, a version only for one, a language only as a code', () => {
    expect(printAskOf(new URLSearchParams('plans=a,b&version=v&language=ro'))).toEqual({ plans: ['a', 'b'], version: null, language: 'ro' })
    expect(printAskOf(new URLSearchParams('plans=a&version=v&language=<x>'))).toEqual({ plans: ['a'], version: 'v', language: null })
  })
})

describe('who may do what, said from facts', () => {
  const can = plansCan(ALL.owner)
  it('approve: the author and an editor are held, a second person may; a draft with problems is held', () => {
    expect(approveHeld(RECORD, 'someone-else', can, false)).toBeNull()
    expect(approveHeld(RECORD, MARTA.id, can, false)?.key).toBe('approve.author')
    expect(approveHeld({ ...RECORD, may: { ...RECORD.may, approve: false, approveHeld: 'You changed version 2' } }, 'someone-else', can, false)?.key).toBe('approve.editor')
    expect(approveHeld(RECORD, 'someone-else', plansCan(['quality.plans.view']), false)?.key).toBe('approve.noRight')
    expect(approveHeld({ ...RECORD, current: { ...RECORD.current, problems: [{ path: 'checks', message: 'x' }] } }, 'someone-else', can, false)?.key).toBe('approve.notReady')
    expect(approveHeld(RECORD_APPROVED, 'someone-else', can, false)?.key).toBe('approve.noDraft')
  })

  it('the band: approve for a second person, submit for the author, start a version when none is drafted', () => {
    expect(bandPrimary(RECORD, 'someone-else', can)).toBe('approve')
    expect(bandPrimary({ ...RECORD, current: { ...RECORD.current, submitted: null } }, MARTA.id, can)).toBe('submit')
    expect(bandPrimary(RECORD_APPROVED, MARTA.id, can)).toBe('newVersion')
    expect(bandPrimary(RECORD_APPROVED, MARTA.id, plansCan(['quality.plans.view']))).toBeNull()
  })

  it('an approved version is read-only; changing needs the right', () => {
    expect(editHeld(RECORD, can, false)).toBeNull()
    expect(editHeld(RECORD_APPROVED, can, false)?.key).toBe('held.approved')
    expect(editHeld(RECORD, plansCan(['quality.plans.view']), false)?.key).toBe('held.noManage')
    expect(editHeld(RECORD, can, true)?.key).toBe('held.offline')
  })

  it('applies to: only what changed is sent, at the plan’s version', () => {
    const draft = appliesDraftOf(RECORD.plan)
    expect(appliesChanges(RECORD.plan, draft)).toBe(0)
    const changed = { ...draft, chips: draft.chips.slice(1) }
    expect(appliesChanges(RECORD.plan, changed)).toBe(1)
    expect(appliesBody(RECORD.plan, changed)).toEqual({ version: RECORD.plan.version, appliesTo: [{ kind: 'CUSTOMER', value: RECORD.plan.appliesTo[1]!.value }] })
  })

  it('an API refusal is said by its code, a stale version by its own words', () => {
    expect(problemOf(new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: 'refusal/AUTHOR', message: 'You wrote version 2' }]))).toBe('refusal.AUTHOR')
    expect(problemOf(new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: 'version', message: 'The current version is 4.' }]))).toBe('problem.stale')
    expect(problemOf(new ApiError('conflict', 409, 'conflict', 'x'))).toBe('problem.conflict')
    expect(problemOf(new Error('x'))).toBe('problem.unavailable')
  })
})

describe('AQL profiles and the rules: one save per tab', () => {
  it('profiles: a new one, a changed one, the default moved; problems held', () => {
    const drafts = PROFILES.profiles.map(profileDraftOf)
    expect(profileChanges(profilePlan(PROFILES.profiles, drafts))).toBe(0)
    expect(profilesProblems(drafts)).toEqual([])
    const changed = [{ ...drafts[0]!, isDefault: false }, { ...drafts[1]!, isDefault: true, minor: '4.0' }, ...drafts.slice(2)]
    const plan = profilePlan(PROFILES.profiles, changed)
    expect(plan.defaultTo).toBe(drafts[1]!.id)
    expect(plan.edits.map((edit) => edit.profile.code)).toEqual(['AQL-EXM'])
    expect(profileChanges(plan)).toBe(2)
    expect(profilesProblems([{ ...drafts[0]!, active: false }]).map((entry) => entry.key)).toEqual(['profiles.defaultRetired', 'profiles.noDefault'])
  })

  it('rules: reordered, switched, removed and new, each counted once; a rule’s problems from the events’ matrix', () => {
    const drafts = RULES_ANSWER.rules.map(ruleDraftOf)
    expect(rulesChanges(rulesPlan(RULES_ANSWER.rules, drafts))).toBe(0)
    const moved = rulesPlan(RULES_ANSWER.rules, [drafts[1]!, drafts[0]!, drafts[2]!, drafts[3]!])
    expect(moved.reordered).toBe(true)
    expect(rulesChanges(moved)).toBe(1)
    const edited = rulesPlan(RULES_ANSWER.rules, [drafts[0]!, { ...drafts[2]!, active: true }, drafts[3]!])
    expect(edited.deletes.map((rule) => rule.id)).toEqual([drafts[1]!.id])
    expect(edited.edits.length).toBe(1)
    const events = RULES_ANSWER.events.map((entry) => ({ event: entry.event, available: entry.available, stages: entry.stages, frequencies: entry.frequencies.map((item) => item.frequency), chipKinds: entry.chipKinds }))
    const plans = PLAN_ROWS.map((row) => ({ id: row.id, stage: row.stage, approved: !!row.approved }))
    expect(ruleProblems(drafts[0]!, events, plans)).toEqual([])
    expect(ruleProblems({ ...drafts[0]!, event: 'RETURN_RECEIVED' }, events, plans).map((entry) => entry.key)).toEqual(['rules.eventHeld'])
    // B-W2b-213: packing names a final plan; due within 1 to 720 hours.
    expect(ruleProblems({ ...drafts[0]!, event: 'PACKING' }, events, plans).map((entry) => entry.key)).toEqual(['rules.planStage'])
    expect(ruleProblems({ ...drafts[0]!, dueHours: 0 }, events, plans).map((entry) => entry.key)).toEqual(['rules.dueHoursRange'])
    expect(ruleProblems({ ...drafts[0]!, dueHours: 8 }, events, plans)).toEqual([])
    expect(ruleProblems({ ...drafts[1]!, chips: [{ kind: 'MATERIAL', value: 'x', label: 'x' }] }, events, plans).map((entry) => entry.key)).toEqual(['rules.chipKind'])
    expect(ruleProblems({ ...drafts[2]!, active: true, planId: PLAN_ROWS[1]!.id }, events, plans).map((entry) => entry.key)).toEqual(['rules.noApproved'])
    expect(ruleProblems({ ...drafts[2]!, active: false, planId: PLAN_ROWS[1]!.id }, events, plans)).toEqual([])
  })
})

describe('AqlSummary says the engine’s plan in our words', () => {
  it('lot 480 at general level II: code letter H, inspect 50', () => {
    const plan = samplingPlan({ lotSize: 480, level: 'II', aqlMajor: '2.5', aqlMinor: '4.0' })
    expect(derivation(plan)).toEqual({ key: 'derivation.general', params: { lot: 480, level: 'II', letter: 'H', sample: 50 } })
    expect(notesOf(plan)).toEqual([])
  })
  it('lot 50 with major 2.5 and minor 4.0: the arrows give two samples, the larger is inspected and said', () => {
    const plan = samplingPlan({ lotSize: 50, level: 'II', aqlMajor: '2.5', aqlMinor: '4.0' })
    expect(plan.samplesDiffer).toBe(true)
    const keys = notesOf(plan).map((note) => note.key)
    expect(keys).toContain('note.differ')
    expect(keys).toContain('note.stricter')
  })
  it('a lot of one is inspected whole', () => {
    expect(derivation(samplingPlan({ lotSize: 1, level: 'II', aqlMajor: '2.5', aqlMinor: '4.0' })).key).toBe('derivation.one')
  })
})

const NAMESPACES = [...new Set([...Object.keys(en), ...Object.keys(enAql)])].filter((name) => /^[a-zA-Z]+$/.test(name))
const LEFT_KEY = new RegExp(`\\b(?:${NAMESPACES.join('|')})\\.[a-zA-Z_]+(?:\\.[a-zA-Z_]+)*\\b`)
const LEFT_PLACEHOLDER = /\{[a-zA-Z]+\}/
/** Permission names are said on purpose ("needs quality.plans.manage"); codes like DEMO-… and the zone are data. */
const SAID = /\b(?:quality|product|parties)\.[a-zA-Z.]+|Europe\/Rome/g

function render(screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell', 'lists', 'records', 'ds-words']) }, createElement(View, { model })))
}

describe('SCR-077, SCR-077-plan, SCR-077-print: every design case draws in both languages with no key left on screen', () => {
  for (const screen of [pageScreen, recordScreen, printScreen] as unknown as DesignScreen<unknown>[]) {
    it(`${screen.screen}: ${screen.cases.length} cases × it, en`, () => {
      for (const item of screen.cases) {
        for (const locale of LOCALES) {
          const html = render(screen, item.model, locale).replace(SAID, '')
          expect(html.length, `${item.id}`).toBeGreaterThan(200)
          expect(html.match(LEFT_KEY)?.[0] ?? null, `${screen.screen} ${item.id} (${locale})`).toBeNull()
          expect(html.match(LEFT_PLACEHOLDER)?.[0] ?? null, `${screen.screen} ${item.id} (${locale}) placeholder`).toBeNull()
        }
      }
    })
  }

  it('the Italian page speaks Italian: the approval and the calculator', () => {
    const approve = render(recordScreen as unknown as DesignScreen<unknown>, recordScreen.cases.find((item) => item.id === 'approve')!.model, 'it')
    expect(approve).toContain('Approva la versione 2')
    expect(approve).toContain('Scritta da Marta Demo, non da te.')
    const calc = render(pageScreen as unknown as DesignScreen<unknown>, pageScreen.cases.find((item) => item.id === 'calculator')!.model, 'it')
    expect(calc).toContain('Lotto 480 · livello generale II → lettera codice H → controllare 50.')
    const author = render(recordScreen as unknown as DesignScreen<unknown>, recordScreen.cases.find((item) => item.id === 'approve-author')!.model, 'en')
    expect(author).toContain('You wrote version 2: you may not approve it.')
  })
})
