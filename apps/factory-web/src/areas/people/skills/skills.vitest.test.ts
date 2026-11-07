import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { SKILL_KINDS, SKILL_LEVELS, SKILL_REFUSALS, AUTHORISATION_STATES } from '@nexus/factory-domain/people/skills/rules'
import { createApiClient, type ApiClient } from '../../../lib/api/client'
import { ApiError } from '../../../lib/api/errors'
import type { DesignScreen } from '../../../lib/design/design-screen'
import { LOCALES } from '../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { authoriseMachine, getMatrix, removeLevel, revokeAuthorisation, setLevel, signOffTrainee } from './api'
import { designScreen as printScreen } from './print/fixtures'
import { designScreen as tabScreen } from './record/fixtures'
import { designScreen as matrixScreen, MATRIX, ROWS, SKILLS } from './fixtures'
import {
  authoriseHeld,
  cellKey,
  classKept,
  firstAtSites,
  groupOf,
  historyAction,
  historyLevel,
  HISTORY_ACTIONS,
  isNarrowed,
  levelChange,
  levelOfKey,
  matrixColumns,
  placesOf,
  tileValue,
  trainingOf,
  printAddress,
  printIdsOf,
  reasonHeld,
  rowsShown,
  signOffHeld,
  skillRefusalOf,
  skillsAddressOf,
  skillsAddressText,
  skillsCan,
  skillsProblem,
  trainersFor,
} from './model'
import { skillDraftHeld } from './view/SkillDialogs'

/**
 * People › Skills & training (SCR-160, the employee's tab, the A3 print; B-W2b-65 on the API of B-W2b-39): who may do what,
 * the address, what 1–4 sends, who may sign as trainer, the first authorisation of a class at a site, what holds a dialog,
 * the refusals in words, the calls as the API takes them, and every design case in Italian and English with no key left.
 */

const template = (key: string) => [...(templateOf(key)?.permissions ?? [])]

describe('skills: who may do what', () => {
  it('reads the rights from the role templates', () => {
    expect(skillsCan(template('floor_supervisor'))).toMatchObject({ view: true, manage: true, authorise: true })
    expect(skillsCan(template('read_only'))).toMatchObject({ view: true, manage: false, authorise: false })
    expect(skillsCan(template('sales')).view).toBe(false)
  })
})

describe('skills: the address', () => {
  it('a state goes in the address and back, defaults left out, other terms kept', () => {
    const address = skillsAddressOf(new URLSearchParams('tile=TRAINEES&show=MACHINES&sort=NAME&line=l1&team=t1&q=Rossi'))
    expect(address).toEqual({ tile: 'TRAINEES', show: 'MACHINES', sort: 'NAME', lineId: 'l1', teamId: 't1', q: 'Rossi' })
    expect(skillsAddressOf(new URLSearchParams(skillsAddressText(address).slice(1)))).toEqual(address)
    expect(skillsAddressText(skillsAddressOf(null))).toBe('')
    expect(skillsAddressText(skillsAddressOf(null), new URLSearchParams('mode=cards'))).toBe('?mode=cards')
  })

  it('a word that is no tile, Show or order falls back; rows never sort by anything but team or name', () => {
    expect(skillsAddressOf(new URLSearchParams('tile=BEST&show=SCORE&sort=LEVEL'))).toMatchObject({ tile: null, show: 'ALL', sort: 'TEAM' })
  })

  it('knows a narrowed view', () => {
    expect(isNarrowed(skillsAddressOf(null))).toBe(false)
    expect(isNarrowed(skillsAddressOf(new URLSearchParams('line=l1')))).toBe(true)
  })

  it('the print keeps the view and the rows chosen', () => {
    const address = skillsAddressOf(new URLSearchParams('tile=TRAINEES'))
    expect(printAddress('/w/DEMO', address)).toBe('/w/DEMO/people/skills/print?tile=TRAINEES')
    expect(printAddress('/w/DEMO', address, ['a', 'b'])).toBe('/w/DEMO/people/skills/print?tile=TRAINEES&ids=a%2Cb')
    expect(printIdsOf(new URLSearchParams('ids=a,b'))).toEqual(['a', 'b'])
  })
})

describe('skills: the matrix', () => {
  it('columns: skills, then machines, then the safety courses (B-W2b-146); Show narrows them', () => {
    expect(matrixColumns(MATRIX, 'ALL').map((column) => column.kind)).toEqual([...SKILLS.map(() => 'skill'), 'machine', 'machine', ...MATRIX.courses.map(() => 'course')])
    expect(matrixColumns(MATRIX, 'SKILLS').every((column) => column.kind === 'skill')).toBe(true)
    expect(matrixColumns(MATRIX, 'MACHINES').every((column) => column.kind === 'machine')).toBe(true)
    expect(matrixColumns(MATRIX, 'SAFETY').map((column) => column.id)).toEqual(MATRIX.courses.map((course) => course.id))
  })

  it('the training tiles say "—" (null) when the caller reads no safety record; never a figure about one person', () => {
    expect(tileValue(MATRIX.tiles, 'TRAINING_OVERDUE')).toBe(2)
    expect(tileValue({ ...MATRIX.tiles, trainingOverdue: null }, 'TRAINING_OVERDUE')).toBeNull()
    expect(tileValue(MATRIX.tiles, 'AUTHORISATIONS_HELD')).toBe(1)
    expect(trainingOf(ROWS[1]!, MATRIX.courses[1]!.id)?.state).toBe('NEEDED')
    expect(trainingOf({ ...ROWS[1]!, trainings: null }, MATRIX.courses[1]!.id)).toBeNull()
  })

  it('line and team narrow by what each row shows', () => {
    const { lines, teams } = placesOf(ROWS)
    expect(lines).toHaveLength(2)
    expect(teams).toHaveLength(2)
    expect(rowsShown(ROWS, { lineId: lines[1]!.id, teamId: null }).map((row) => row.name)).toEqual(['Sara Demo', 'Davide Modello'])
    expect(groupOf(ROWS[0]!)).toBe('L-A › A1')
  })

  it('no row key is a figure about a person', () => {
    for (const key of Object.keys(ROWS[0]!)) expect(key).not.toMatch(/score|rank|efficiency|count|total|percent/i)
  })
})

describe('skills: 1–4 and the cells', () => {
  it('reads 1 to 4 as the four levels, anything else as nothing', () => {
    expect(['1', '2', '3', '4'].map(levelOfKey)).toEqual([...SKILL_LEVELS])
    expect(levelOfKey('5')).toBeNull()
    expect(levelOfKey('x')).toBeNull()
  })

  it('a new level sends no version, a change sends the version read, the same level sends nothing', () => {
    expect(levelChange('e', 's', null, 'EXPERT')).toEqual({ employeeId: 'e', skillId: 's', level: 'EXPERT' })
    expect(levelChange('e', 's', { level: 'CAN_DO', version: 4 }, 'EXPERT')).toEqual({ employeeId: 'e', skillId: 's', level: 'EXPERT', version: 4 })
    expect(levelChange('e', 's', { level: 'EXPERT', version: 4 }, 'EXPERT')).toBeNull()
  })

  it('a cell is one person and one skill or class', () => {
    expect(cellKey({ employeeId: 'e', kind: 'skill', skillId: 's' })).toBe('e:s')
    expect(cellKey({ employeeId: 'e', kind: 'machine', classId: 'c' })).toBe('e:c')
  })

  it('the trainer holds the skill as Trainer, is not the trainee, is of the company, and is no trainee on it', () => {
    const giulia = ROWS[0]!
    const paolo = ROWS[1]!
    const skillId = SKILLS[0]!.id
    expect(trainersFor(ROWS, paolo, skillId).map((row) => row.name)).toEqual([giulia.name])
    expect(trainersFor(ROWS, giulia, skillId)).toEqual([])
    expect(trainersFor(ROWS, { ...paolo, companyId: 'other' }, skillId)).toEqual([])
    const asTrainee = { ...giulia, levels: giulia.levels.map((cell) => ({ ...cell, trainee: 'TRAINEE' as const })) }
    expect(trainersFor([asTrainee, paolo], paolo, skillId)).toEqual([])
  })

  it('says which sites a first authorisation starts holding', () => {
    const [stitch, press] = MATRIX.machineClasses
    expect(classKept(stitch!, ROWS[0]!.siteId)).toBe(true)
    expect(firstAtSites(stitch!, ROWS)).toEqual([])
    expect(firstAtSites(press!, ROWS)).toEqual([ROWS[0]!.siteId])
    expect(firstAtSites(null, ROWS)).toEqual([])
  })
})

describe('skills: what holds a dialog', () => {
  it('Authorise says what is missing, in order', () => {
    const draft = { classId: 'c', from: '2026-11-02', until: null }
    expect(authoriseHeld([], draft)).toBe('held.choosePerson')
    expect(authoriseHeld([{}], { ...draft, classId: null })).toBe('held.chooseClass')
    expect(authoriseHeld([{}], { ...draft, from: '' })).toBe('held.chooseDate')
    expect(authoriseHeld([{}], { ...draft, until: '2026-11-01' })).toBe('held.untilBeforeFrom')
    expect(authoriseHeld([{}], draft)).toBeNull()
  })

  it('Sign off stays between the first day and today', () => {
    const facts = { since: '2026-09-01', today: '2026-11-02' }
    const draft = { on: '2026-11-02', trainerId: null, level: null }
    expect(signOffHeld(draft, facts)).toBeNull()
    expect(signOffHeld({ ...draft, on: '2026-11-03' }, facts)).toBe('held.signOffFuture')
    expect(signOffHeld({ ...draft, on: '2026-08-31' }, facts)).toBe('held.signOffBefore')
    expect(signOffHeld({ ...draft, on: '' }, facts)).toBe('held.chooseDate')
  })

  it('a new skill names its operation or class of machine; a General one needs neither', () => {
    const draft = { code: 'TAGLIO', nameIt: 'Taglio', nameEn: '', kind: 'OPERATION' as const, targetId: null }
    expect(skillDraftHeld(draft)).toBe('held.skillOperation')
    expect(skillDraftHeld({ ...draft, targetId: 'op' })).toBeNull()
    expect(skillDraftHeld({ ...draft, kind: 'MACHINE' })).toBe('held.skillClass')
    expect(skillDraftHeld({ ...draft, kind: 'GENERAL' })).toBeNull()
    expect(skillDraftHeld({ ...draft, kind: 'GENERAL', code: 'con spazi' })).toBe('held.skillCode')
    expect(skillDraftHeld({ ...draft, kind: 'GENERAL', nameIt: ' ' })).toBe('held.skillName')
  })

  it('a reason is a few words', () => {
    expect(reasonHeld('  ')).toBe('held.needReason')
    expect(reasonHeld('ok')).toBe('held.needReason')
    expect(reasonHeld('sbagliato')).toBeNull()
  })
})

describe('skills: a refusal in words', () => {
  it('reads the refusal code, then a field, then the shared words', () => {
    const refused = new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: 'refusal/SELF_DECISION' }])
    expect(skillRefusalOf(refused)).toBe('SELF_DECISION')
    expect(skillsProblem(refused)).toEqual({ ns: 'skills', words: { key: 'refusal.SELF_DECISION' } })
    expect(skillsProblem(new ApiError('invalid', 400, 'validation', 'x', null, [{ path: 'body/reason' }]))).toEqual({ ns: 'skills', words: { key: 'field.reason' } })
    expect(skillsProblem(new ApiError('conflict', 409, 'conflict', 'x'))).toEqual({ ns: 'people', words: { key: 'problem.conflict' } })
  })

  it('a history entry says its action and the level it set', () => {
    expect(historyAction({ action: 'people.signOffTrainee' })).toBe('history.signOffTrainee')
    expect(historyAction({ action: 'people.unknown' })).toBe('history.other')
    expect(historyLevel({ after: { level: 'EXPERT' } })).toBe('EXPERT')
    expect(historyLevel({ after: null })).toBeNull()
  })
})

interface Sent {
  url: string
  init: RequestInit
}

function mockApi(answers: { status: number; body: unknown }[]): { api: ApiClient; calls: Sent[] } {
  const calls: Sent[] = []
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    const next = answers.shift()!
    return new Response(JSON.stringify(next.body), { status: next.status, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof globalThis.fetch
  return { api: createApiClient({ baseUrl: '/api', fetch, company: 'DEMO', csrfToken: () => 'csrf-demo' }), calls }
}

const LEVEL = { id: 'l', employeeId: 'e', skill: { id: 's', code: 'C', name: 'N', kind: 'OPERATION', status: 'ACTIVE' }, level: 'EXPERT', since: '2026-01-01', assessedAt: '2026-01-01T00:00:00Z', assessedBy: null, traineeUntil: null, trainee: 'NONE', signedOffOn: null, signedOffBy: null, trainer: null, removedAt: null, removedBy: null, removeReason: null, version: 2 }
const AUTHORISATION = { id: 'a', employeeId: 'e', machineClass: { id: 'c', code: 'C', labelEn: 'E', labelIt: 'I' }, authorisedOn: '2026-01-01', validUntil: null, state: 'AUTHORISED', authorisedBy: null, revokedAt: null, revokedBy: null, revokeReason: null, version: 1 }

describe('skills: the calls as the API takes them', () => {
  it('reads the matrix of the site with every column (tiles stay true whatever Show says)', async () => {
    const { api, calls } = mockApi([{ status: 200, body: MATRIX }])
    await getMatrix(api, { siteId: 's1', tile: 'TRAINEES', sort: 'NAME', q: ' Rossi ' })
    expect(calls[0]!.url).toBe('/api/people/skills/matrix?siteId=s1&tile=TRAINEES&sort=NAME&q=Rossi')
  })

  it('every write carries an Idempotency-Key and the version read', async () => {
    const { api, calls } = mockApi([
      { status: 200, body: { level: LEVEL, changed: true } },
      { status: 200, body: { level: LEVEL } },
      { status: 200, body: { level: LEVEL } },
      { status: 201, body: { authorisation: AUTHORISATION, words: 'English is never drawn' } },
      { status: 200, body: { authorisation: AUTHORISATION } },
    ])
    await setLevel(api, { employeeId: 'e', skillId: 's', level: 'EXPERT', version: 1 })
    await signOffTrainee(api, 'l', { version: 2, signedOffOn: '2026-11-02' }, 'key-1')
    await removeLevel(api, 'l', { version: 2, reason: 'sbagliato' })
    await authoriseMachine(api, { employeeId: 'e', machineClassId: 'c', authorisedOn: '2026-11-02' })
    await revokeAuthorisation(api, 'a', { version: 1, reason: 'cambio reparto' })
    expect(calls.map((call) => call.url)).toEqual(['/api/people/skills/levels', '/api/people/skills/levels/l/sign-off', '/api/people/skills/levels/l/remove', '/api/people/skills/authorisations', '/api/people/skills/authorisations/a/revoke'])
    for (const call of calls) expect(new Headers(call.init.headers).get('idempotency-key'), call.url).toBeTruthy()
    expect(new Headers(calls[1]!.init.headers).get('idempotency-key')).toBe('key-1')
    expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({ version: 1 })
  })
})

const LEFT_KEY = /(?:^|[>\s"])(?:band|tile|tileHint|list|show|sort|cell|level|machine|authorise|signOff|remove|revoke|catalogue|held|refusal|keys|tab|print|done|field|history|kind|status|stepUp|common|problem|privacy)\.[a-zA-Z_]+/
const LEFT_PLACEHOLDER = /\{[a-zA-Z]+\}/

function render(screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell', 'lists', 'records', 'people', 'people-skills', 'ds-words']) }, createElement(View, { model })))
}

describe('every design case draws in both languages with no key left on screen', () => {
  for (const screen of [matrixScreen, tabScreen, printScreen] as unknown as DesignScreen<unknown>[]) {
    it(`${screen.screen}: ${screen.cases.length} cases × it, en`, () => {
      for (const item of screen.cases) {
        for (const locale of LOCALES) {
          const html = render(screen, item.model, locale)
          expect(html.length, `${screen.screen}/${item.id}`).toBeGreaterThan(200)
          expect(html.match(LEFT_KEY)?.[0] ?? null, `${screen.screen}/${item.id} (${locale})`).toBeNull()
          expect(html.match(LEFT_PLACEHOLDER)?.[0] ?? null, `${screen.screen}/${item.id} (${locale}) placeholder`).toBeNull()
        }
      }
    })
  }

  it('the dynamic words exist in both languages (levels, kinds, states, refusals, history)', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['people-skills'])['people-skills']!)
      const has = (key: string) => expect(t(key), `${locale}: ${key}`).not.toBe(key)
      for (const level of SKILL_LEVELS) has(`level.${level}`)
      for (const kind of SKILL_KINDS) has(`kind.${kind}`)
      for (const state of AUTHORISATION_STATES) has(`machine.${state}`)
      for (const refusal of SKILL_REFUSALS) has(`refusal.${refusal}`)
      for (const action of HISTORY_ACTIONS) has(`history.${action}`)
    }
  })
})
