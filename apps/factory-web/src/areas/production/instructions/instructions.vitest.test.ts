import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { INSTRUCTION_ICONS, VERSION_STATUSES } from '@nexus/factory-domain/production/instructions/rules'
import { ApiError } from '../../../lib/api/errors'
import type { DesignScreen } from '../../../lib/design/design-screen'
import { LOCALES } from '../../../lib/i18n/locales'
import { CATALOGUE, messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { INSTRUCTION_ICON_KEYS, INSTRUCTION_ICON_MAP, instructionIcon } from '../../../lib/production/instruction-icons'
import { listAddress, recordAddress } from '../../../lib/records/record-links'
import { OFFICE_PAGES, officeNavFor } from '../../../shell/nav/office-nav'
import { permissionCheck } from '../../../lib/session/session'
import { ACKS_HR, ANSWER_V2, ANSWER_V3, ME, RECORD, ROLE_PERMISSIONS, ROWS, VERSIONS } from './demo/fixtures'
import { designScreen as listScreen } from './fixtures'
import {
  approveHeld,
  bandPrimary,
  changesOf,
  cleanWords,
  compareLines,
  createHeld,
  defaultPair,
  draftOf,
  editHeld,
  EMPTY_NEW,
  instructionsCan,
  KNOWN_REFUSALS,
  languagesOf,
  listAddressOf,
  listCsv,
  listQueryText,
  mediaKindOf,
  missingIn,
  moveItem,
  newStep,
  newVersionHeld,
  peopleRows,
  previewSteps,
  problemsOf,
  recordAddressOf,
  recordQuery,
  rowsOfView,
  saveBodyOf,
  sheetLanguageOf,
  sheetProblem,
  shownVersionId,
  siteShare,
  tileCounts,
  writeProblem,
  type Facts,
} from './model'
import { designScreen as previewScreen } from './preview/fixtures'
import { designScreen as recordScreen } from './record/fixtures'
import { designScreen as sheetScreen } from './sheet/fixtures'

const params = (text: string) => new URLSearchParams(text)
const manager = instructionsCan(ROLE_PERMISSIONS.manager)
const facts = (over: Partial<Facts> = {}): Facts => ({ can: manager, me: ME, offline: false, ...over })

describe('rights from the role templates', () => {
  it('the production manager writes and approves, never names; HR names, never writes; quality approves only', () => {
    expect(manager).toMatchObject({ view: true, manage: true, approve: true, people: false, pickOperation: true })
    expect(instructionsCan(ROLE_PERMISSIONS.hr)).toMatchObject({ view: true, manage: false, approve: false, people: true })
    expect(instructionsCan(ROLE_PERMISSIONS.quality)).toMatchObject({ view: true, manage: false, approve: true, people: false })
    expect(instructionsCan(ROLE_PERMISSIONS.supervisor)).toMatchObject({ manage: true, approve: false })
    expect(instructionsCan(ROLE_PERMISSIONS.readOnly)).toMatchObject({ view: true, manage: false, approve: false, people: false })
    expect(instructionsCan(ROLE_PERMISSIONS.sales).view).toBe(false)
  })
})

describe('the list', () => {
  it('reads and writes its address; unknown views fall back', () => {
    const address = listAddressOf(params('view=drafts&q=spalla&new=1'))
    expect(address).toEqual({ view: 'drafts', q: 'spalla', creating: true, typed: false })
    expect(listQueryText(address)).toBe('?view=drafts&q=spalla&new=1')
    expect(listAddressOf(params('view=nope')).view).toBe('active')
    expect(listQueryText(listAddressOf(params('')))).toBe('')
  })

  it('the views and tiles come from the rows (drafts, a floor language missing, never published)', () => {
    expect(rowsOfView(ROWS, 'drafts').map((row) => row.number)).toEqual(['WI-2026-0007', 'WI-2026-0004'])
    expect(rowsOfView(ROWS, 'missing').map((row) => row.number)).toEqual(['WI-2026-0001', 'WI-2026-0006'])
    expect(rowsOfView(ROWS, 'unpublished').map((row) => row.number)).toEqual(['WI-2026-0004'])
    expect(tileCounts({ instructions: ROWS, truncated: false, counts: { active: 6, archived: 1, drafts: 2 }, canManage: true })).toEqual({ active: 6, drafts: 2, missing: 2, unpublished: 1, archived: 1 })
    expect(tileCounts(null).drafts).toBeNull()
  })

  it('the CSV has one line per row, quoted where needed, with no worker anywhere', () => {
    const csv = listCsv(ROWS.slice(0, 2), { header: ['a', 'b'], everyStyle: 'Every style', status: (status) => status, none: '—' })
    const lines = csv.split('\n')
    expect(lines).toHaveLength(3)
    expect(lines[1]).toContain('WI-2026-0007,DEMO-CUC-SPALLA,Cucitura spalla,Every style,v2,v3')
  })

  it('New instruction is held until an operation (and a revision when asked) is chosen', () => {
    expect(createHeld(EMPTY_NEW, manager, false)?.key).toBe('held.pickOperation')
    expect(createHeld({ ...EMPTY_NEW, operationId: 'o1', scope: 'revision' }, manager, false)?.key).toBe('held.pickRevision')
    expect(createHeld({ ...EMPTY_NEW, operationId: 'o1' }, manager, false)).toBeNull()
    expect(createHeld({ ...EMPTY_NEW, operationId: 'o1' }, instructionsCan(ROLE_PERMISSIONS.quality), false)?.key).toBe('held.noManage')
  })
})

describe('the record', () => {
  it('reads and writes its address', () => {
    const address = recordAddressOf(params('tab=versions&compare=v1&approve=1'))
    expect(address).toEqual({ tab: 'versions', version: null, compare: 'v1', approve: true })
    expect(recordQuery(address)).toBe('?tab=versions&compare=v1&approve=1')
    expect(recordAddressOf(params('tab=other')).tab).toBe('steps')
  })

  it('shows the version asked, else the draft, else the one in force', () => {
    expect(shownVersionId(RECORD, null)).toBe(RECORD.draftVersionId)
    expect(shownVersionId(RECORD, VERSIONS[2]!.id)).toBe(VERSIONS[2]!.id)
    expect(shownVersionId({ ...RECORD, draftVersionId: null }, 'gone')).toBe(RECORD.currentVersionId)
    expect(defaultPair(RECORD)).toEqual({ beforeId: VERSIONS[1]!.id, afterId: VERSIONS[0]!.id })
  })

  it('the draft round-trips: no change until something changes; the body drops blank languages', () => {
    const draft = draftOf(ANSWER_V3)
    expect(changesOf(ANSWER_V3, draft)).toBe(0)
    const moved = { ...draft, steps: moveItem(draft.steps, 0, 1) }
    expect(changesOf(ANSWER_V3, moved)).toBe(2)
    const typed = { ...draft, changeNote: 'x', steps: draft.steps.map((step, index) => (index === 1 ? { ...step, text: { ...step.text, ro: '   ' }, safety: { ...step.safety, ro: '' } } : step)) }
    expect(changesOf(ANSWER_V3, typed)).toBe(1)
    const body = saveBodyOf(ANSWER_V3.version, typed)
    expect(body.steps[1]!.text).not.toHaveProperty('ro')
    expect(body.steps[1]!.safety).toEqual({ it: 'Tieni le dita fuori dal piedino.', en: 'Keep your fingers clear of the foot.' })
    expect(body.steps[2]!.safety).toEqual({ it: 'Pelle: mai oltre 110 °C.', en: 'Leather: never above 110 °C.' })
    expect(body.version).toBe(ANSWER_V3.version.version)
    expect(cleanWords({ it: ' a ', en: '' })).toEqual({ it: 'a' })
  })

  it('a new step takes a free code; problems are said at their places', () => {
    const draft = draftOf(ANSWER_V3)
    const step = newStep(draft.steps, 1)
    expect(step.code).toBe('STEP_6')
    const broken = { ...draft, steps: [...draft.steps, { ...step, code: 'CHECK_TAPE' }, { ...step, key: 'b', code: 'bad code', text: { it: 'x' } }] }
    expect(problemsOf(broken).map((problem) => `${problem.path} ${problem.key}`)).toEqual(['steps/5/code problem.code.twice', 'steps/5/text problem.text.missing', 'steps/6/code problem.code.format'])
    expect(problemsOf(draft)).toEqual([])
  })

  it('languages: the floor ones first, the missing marked per step', () => {
    const draft = draftOf(ANSWER_V3)
    expect(languagesOf(draft, ['it', 'en', 'ro'])).toEqual(['it', 'en', 'ro'])
    expect(missingIn(draft.steps[1]!, ['it', 'en', 'ro'])).toEqual(['ro'])
  })

  it('approve is held in the API\'s order, then for unsaved changes and offline; the author never approves', () => {
    const draft = RECORD.versions[0]!
    const content = draftOf(ANSWER_V3)
    expect(approveHeld(RECORD, draft, content, { ...facts(), unsaved: 0 })).toBeNull()
    expect(approveHeld(RECORD, { ...draft, author: { id: ME, name: 'Alex Demo' } }, content, { ...facts(), unsaved: 0 })?.key).toBe('held.ownDraft')
    expect(approveHeld(RECORD, draft, content, { ...facts(), unsaved: 2 })?.key).toBe('held.unsaved')
    expect(approveHeld(RECORD, draft, { ...content, changeNote: ' ' }, { ...facts(), unsaved: 0 })?.key).toBe('held.noNote')
    expect(approveHeld(RECORD, draft, { ...content, steps: [] }, { ...facts(), unsaved: 0 })?.key).toBe('held.noSteps')
    const pending = { ...content, steps: content.steps.map((step, index) => (index === 0 ? { ...step, media: step.media.map((medium) => ({ ...medium, file: medium.file && { ...medium.file, status: 'PENDING_UPLOAD' } })) } : step)) }
    expect(approveHeld(RECORD, draft, pending, { ...facts(), unsaved: 0 })).toEqual({ key: 'held.mediaNotReady', params: { count: 1 } })
    expect(approveHeld(RECORD, draft, content, { ...facts({ can: instructionsCan(ROLE_PERMISSIONS.supervisor) }), unsaved: 0 })?.key).toBe('held.noApprove')
    expect(approveHeld(RECORD, draft, content, { ...facts({ offline: true }), unsaved: 0 })?.key).toBe('held.offline')
  })

  it('a published version is read-only; a new version waits for the open draft', () => {
    expect(editHeld(RECORD, RECORD.versions[1]!, facts())).toEqual({ key: 'held.readOnly.PUBLISHED', params: { number: 2 } })
    expect(editHeld(RECORD, RECORD.versions[0]!, facts())).toBeNull()
    expect(editHeld(RECORD, RECORD.versions[0]!, facts({ can: instructionsCan(ROLE_PERMISSIONS.quality) }))?.key).toBe('held.noManage')
    expect(newVersionHeld(RECORD, facts())).toEqual({ key: 'held.draftExists', params: { number: 3 } })
    expect(bandPrimary(RECORD, facts())).toBe('approve')
    expect(bandPrimary({ ...RECORD, draftVersionId: null }, facts({ can: instructionsCan(ROLE_PERMISSIONS.supervisor) }))).toBe('newVersion')
  })

  it('the API\'s refusals are said from their codes, never its English', () => {
    const refused = new ApiError('conflict', 409, 'conflict', 'Version 3 of WI-1 is your own draft', null, [{ path: 'refusal/OWN_DRAFT', message: 'English words' }])
    expect(writeProblem(refused)).toEqual({ key: 'refusal.OWN_DRAFT', paths: [], stale: false })
    expect(writeProblem(new ApiError('conflict', 409, 'conflict', 'stale')).stale).toBe(true)
    expect(writeProblem(new ApiError('invalid', 400, 'invalid', 'bad', null, [{ path: 'body/steps/1/code', message: 'x' }])).paths).toEqual(['steps/1/code'])
    expect(writeProblem(new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: 'refusal/SOMETHING_NEW' }])).key).toBe('refusal.other')
    expect(sheetProblem(new ApiError('invalid', 400, 'invalid', 'x', null, [{ path: 'company/vatNumber' }]))).toBe('problem.sheetCompany')
  })
})

describe('compare, preview and acknowledgements', () => {
  it('two versions are matched by step code: added, changed, kept', () => {
    const lines = compareLines(ANSWER_V2, ANSWER_V3, 'it')
    expect(lines.map((line) => [line.code, line.before ? 'b' : '-', line.after ? 'a' : '-'])).toEqual([
      ['ALIGN_PANELS', 'b', 'a'],
      ['SEAM_ALLOWANCE', 'b', 'a'],
      ['PRESS_OPEN', 'b', 'a'],
      ['CHECK_TAPE', '-', 'a'],
      ['CHECK_SEAM', 'b', 'a'],
    ])
    expect(lines[1]!.before!.text).toContain('10 mm')
    expect(lines[1]!.after!.text).toContain('12 mm')
  })

  it('the preview speaks the language asked, else falls back and says which', () => {
    const steps = previewSteps(ANSWER_V2, 'ro')
    expect(steps[0]!.shownIn).toBeNull()
    expect(steps[1]!.shownIn).toBe('it')
    expect(steps[1]!.safety).toBe('Tieni le dita fuori dal piedino.')
  })

  it('HR\'s rows: by site, the ones still to see first, hidden names last; a share only where someone holds the skill', () => {
    expect(peopleRows(ACKS_HR).map((row) => row.worker?.name ?? 'hidden')).toEqual(['Operatore Tre', 'Operatrice Due', 'Operatore Uno', 'Operatrice Quattro', 'hidden', 'hidden'])
    expect(siteShare({ seen: 9, of: 11 })).toBe(82)
    expect(siteShare({ seen: 2, of: 0 })).toBeNull()
  })

  it('a picked file is a photo or a video of at most 25 MB', () => {
    expect(mediaKindOf({ type: 'image/jpeg', size: 10 })).toEqual({ kind: 'PHOTO' })
    expect(mediaKindOf({ type: 'video/mp4', size: 10 })).toEqual({ kind: 'VIDEO' })
    expect(mediaKindOf({ type: 'image/gif', size: 10 })).toEqual({ problem: 'media.problem.type' })
    expect(mediaKindOf({ type: 'image/png', size: 26 * 1024 * 1024 })).toEqual({ problem: 'media.problem.tooBig' })
    expect(sheetLanguageOf('xx', 'en')).toBe('en')
  })
})

describe('icons, words and navigation', () => {
  it('every step icon the domain allows has a picture and words in both languages', () => {
    expect([...INSTRUCTION_ICON_KEYS]).toEqual([...INSTRUCTION_ICONS])
    for (const key of INSTRUCTION_ICONS) expect(INSTRUCTION_ICON_MAP[key], key).toBeDefined()
    expect(instructionIcon('unknown')).toBe(instructionIcon(null))
    for (const locale of LOCALES) {
      const words = CATALOGUE[locale]['production-instructions']!
      for (const key of INSTRUCTION_ICONS) expect(words[`icon.${key}`], `${locale} icon.${key}`).toBeTruthy()
      for (const code of KNOWN_REFUSALS) expect(words[`refusal.${code}`], `${locale} refusal.${code}`).toBeTruthy()
      for (const status of VERSION_STATUSES) expect(words[`status.${status}`], `${locale} status.${status}`).toBeTruthy()
      for (const status of VERSION_STATUSES.filter((entry) => entry !== 'DRAFT')) expect(words[`held.readOnly.${status}`], `${locale} held.readOnly.${status}`).toBeTruthy()
    }
  })

  it('the page is built, in the navigation for the roles that read it, and a WorkInstruction opens its record', () => {
    expect(OFFICE_PAGES.has('/production/instructions')).toBe(true)
    expect(recordAddress({ type: 'WorkInstruction', id: 'w1' }, OFFICE_PAGES)).toBe('/production/instructions/w1')
    expect(listAddress('/production/instructions', { q: 'x' }, OFFICE_PAGES)).toBe('/production/instructions?q=x')
    const rows = (permissions: readonly string[]) => officeNavFor(permissionCheck([...permissions])).areas.flatMap((area) => (area.sections ?? []).flatMap((section) => section.items.map((item) => item.href)))
    expect(rows(ROLE_PERMISSIONS.hr)).toContain('/production/instructions')
    expect(rows(ROLE_PERMISSIONS.sales)).not.toContain('/production/instructions')
  })
})

const LEFT_KEY = /\b(?:common|held|list|record|status|tile|tileHint|view|bulk|archive|restore|csv|language|new|typed|tab|live|steps|note|ack|acks|settings|icon|problem|refusal|notice|media|versions|compare|approve|newVersion|discard|paper|preview|sheet|version|col|keys|dialog|fileStatus|revisionStatus)\.[a-zA-Z]+(?:\.[a-zA-Z_]+)*\b/

function render(screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(View, { model })))
}

describe('every design case draws in both languages with no key left on screen', () => {
  for (const screen of [listScreen, recordScreen, previewScreen, sheetScreen] as DesignScreen<unknown>[]) {
    for (const locale of LOCALES) {
      it(`${screen.screen} in ${locale}: ${screen.cases.length} cases`, () => {
        for (const item of screen.cases) {
          const html = render(screen, item.model, locale)
            .replace(/https?:\/\/[^"\s<]+/g, '')
            .replace(/data:[^"]+/g, '')
            .replace(/\b(?:production|product|files)\.[a-z]+(?:\.[a-z]+)?\b/g, '')
          expect(html.match(LEFT_KEY)?.[0] ?? null, `${screen.screen}/${item.id} (${locale})`).toBeNull()
        }
      })
    }
  }
})
