import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { FLOOR_PROBLEMS } from '@nexus/factory-domain/product/changes/rules'
import { DISPOSITIONS, NEWER_SPEC_STATES } from '@nexus/factory-domain/product/versions/drift'
import { ACK_DUE } from '@nexus/factory-domain/production/instructions/rules'
import { QUEUED_ACTIONS } from '@nexus/factory-domain/floor-sync/kinds'
import type { ApiClient } from '../../../lib/api/client'
import type { DesignScreen } from '../../../lib/design/design-screen'
import { LOCALES } from '../../../lib/i18n/locales'
import { CATALOGUE, messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { homeTiles } from '../../model'
import { FLOOR_PAGES } from '../../moves'
import { whatKeyOf } from '../../queue/actions'
import { FLOOR_NAMESPACES, TASK_ROUTES } from '../routes'
import { readInstructionParts, shownFlag, startOpensInstruction } from '../scans/instructions'
import type { OpenItem } from '../scans/timing'
import type { FloorInstruction, MineAnswer, NewerSpec } from './api'
import { designScreen as elsewhereScreen } from './elsewhere/fixtures'
import { designScreen } from './fixtures'
import { forPerson, keepInstruction, keptInstruction, markOpenedBeforeStart, markSeen, offerInstructions, openedBeforeStart, seenHere, takeInstructionsOffer } from './memory'
import {
  allShown,
  bundleForDue,
  clampStep,
  dueCount,
  dueOf,
  decimalWords,
  dueRows,
  EMPTY_PROBLEM,
  flagOf,
  inHand,
  measureText,
  materialName,
  newerLine,
  openByItself,
  opensBeforeStart,
  photoName,
  problemBody,
  PROBLEM_NOTE_MAX,
  readAloudText,
  seenBody,
  seenHeld,
  sendHeld,
  settingRows,
  withShown,
  zoomIn,
  zoomOut,
  ZOOM_LEVELS,
} from './model'

/**
 * SCR-174 Spec & instructions (B-W2b-232) and its parts on Operation and My work (SCR-288): the rules without a screen, what the
 * tablet keeps, the Operation screen's read and Start hook, the tile and page, the words in both languages, and every SCR-288 case
 * drawn (SCR-174's own cases are drawn by tasks.vitest.test.ts with every floor task).
 */

const ANSWER = designScreen.cases.find((item) => item.id === 'first-time')!.model.step as Extract<typeof designScreen.cases[number]['model']['step'], { kind: 'open' }>
const BASE: FloorInstruction = ANSWER.work.answer
const VERSION = BASE.instruction!.version.id
const none = () => false

const item = (bundleId: string, operation: string, state: OpenItem['state']): OpenItem => ({ bundleId, bundleCode: `BN-${bundleId}`, operation: { id: `op-${operation}`, seq: 20, code: operation, name: operation }, state, pausedAt: null, runningSince: null, pausedAtClockOut: false })

const words = (locale: (typeof LOCALES)[number]) => CATALOGUE[locale]['floor-instructions'] ?? {}

describe('what waits for the person (MES-110, MES-119)', () => {
  it('Seen waits as the API says, unless this tablet holds the person’s Seen of that version', () => {
    expect(dueOf(BASE, none)).toBe('FIRST')
    expect(dueOf(BASE, (id) => id === VERSION)).toBeNull()
    expect(dueOf({ ...BASE, acknowledgement: { due: null, seenAt: '2026-11-09T16:05:00.000Z' } }, none)).toBeNull()
    expect(dueOf({ ...BASE, instruction: null, acknowledgement: null }, none)).toBeNull()
  })

  it('the card’s flag; the instruction opens before Start once per visit (Back, then the next Start goes)', () => {
    const flag = flagOf(BASE, none)!
    expect(flag).toEqual({ instructionId: 'wi-7', number: 'WI-DEMO-0007', versionId: VERSION, versionNumber: 4, due: 'FIRST' })
    expect(flagOf({ ...BASE, instruction: null }, none)).toBeNull()
    expect(opensBeforeStart(flag, none)).toBe(true)
    expect(opensBeforeStart(flag, (id) => id === VERSION)).toBe(false)
    expect(opensBeforeStart({ ...flag, due: null }, none)).toBe(false)
    expect(opensBeforeStart(null, none)).toBe(false)
  })

  it('My work counts the versions waiting, less those Seen here; New for you lists them newest first', () => {
    const mine: MineAnswer = {
      due: [
        { instructionId: 'a', number: 'WI-1', forRevision: false, operation: { id: 'o1', code: 'SEW', name: 'Sew' }, versionId: 'v1', versionNumber: 2, publishedAt: '2026-11-01T08:00:00.000Z', reason: 'CHANGED' },
        { instructionId: 'b', number: 'WI-2', forRevision: true, operation: { id: 'o2', code: 'PACK', name: 'Pack' }, versionId: 'v2', versionNumber: 1, publishedAt: '2026-11-08T08:00:00.000Z', reason: 'FIRST' },
      ],
      seen: [],
    }
    expect(dueCount(mine, none)).toBe(2)
    expect(dueCount(mine, (id) => id === 'v1')).toBe(1)
    expect(dueCount(null, none)).toBe(0)
    expect(dueRows(mine, none).map((row) => row.versionId)).toEqual(['v2', 'v1'])
  })

  it('opens for the bundle in hand: the one running opens by itself; a due row finds an open bundle at its operation', () => {
    const items = [item('1', 'SEW', 'PAUSED'), item('2', 'PACK', 'RUNNING'), item('2', 'PACK', 'RUNNING'), item('3', 'QC', 'REPORTED')]
    expect(inHand(items).map((row) => row.bundleId)).toEqual(['2', '1'])
    expect(openByItself(items)?.bundleId).toBe('2')
    expect(openByItself([item('1', 'SEW', 'PAUSED')])).toBeNull()
    expect(bundleForDue({ operation: { id: 'x', code: 'SEW', name: 'Sew' } }, items)?.bundleId).toBe('1')
    expect(bundleForDue({ operation: { id: 'x', code: 'CUT', name: 'Cut' } }, items)).toBeNull()
  })
})

describe('one step per screen, Seen held until every step was shown', () => {
  it('keeps the step inside the list and counts what was on screen', () => {
    expect(clampStep(-3, 4)).toBe(0)
    expect(clampStep(9, 4)).toBe(3)
    expect(clampStep(1.7, 4)).toBe(1)
    expect(clampStep(2, 0)).toBe(0)
    expect(withShown([0, 2], 1)).toEqual([0, 1, 2])
    expect(withShown([0, 1], 1)).toEqual([0, 1])
    expect(allShown([0, 1, 2, 3], 4)).toBe(true)
    expect(allShown([0, 2, 3], 4)).toBe(false)
  })

  it('"Look at every step first", then Seen; busy while it is sent', () => {
    expect(seenHeld({ count: 4, shown: [0, 1], busy: false })).toEqual({ key: 'steps', seen: 2, count: 4 })
    expect(seenHeld({ count: 4, shown: [0, 1, 2, 3], busy: false })).toBeNull()
    expect(seenHeld({ count: 4, shown: [0, 1, 2, 3], busy: true })).toEqual({ key: 'busy' })
    expect(seenHeld({ count: 0, shown: [], busy: false })).toBeNull()
  })

  it('Seen sends the version and the two-letter language it was shown in', () => {
    expect(seenBody(BASE)).toEqual({ versionId: VERSION, locale: 'it' })
    expect(seenBody({ ...BASE, language: 'pt-BR' })).toEqual({ versionId: VERSION })
    expect(seenBody({ ...BASE, instruction: null })).toBeNull()
  })

  it('reads a step aloud with its number and safety note; zooms in steps and stops at the ends', () => {
    expect(readAloudText({ words: 'Cuci', safety: 'Dita lontane' }, 1)).toBe('2. Cuci. Dita lontane')
    expect(readAloudText({ words: 'Cuci', safety: null }, 0)).toBe('1. Cuci')
    expect(zoomIn(1)).toBe(1.5)
    expect(zoomIn(ZOOM_LEVELS[ZOOM_LEVELS.length - 1]!)).toBe(3)
    expect(zoomOut(1.5)).toBe(1)
    expect(zoomOut(1)).toBe(1)
  })
})

describe('Spec changed in floor words (PRD-195; B-W2b-220)', () => {
  const spec = (extra: Partial<NewerSpec['newer']>): NewerSpec => ({ workOrder: { id: 'w', number: 'WO-1' }, revision: { revision: 2, status: 'OBSOLETE' }, newer: { state: 'NEWER_RELEASED', banner: true, newPages: false, message: 'English the floor never shows', newer: { id: 'r3', revision: 3, releasedOn: '2026-11-09' }, decision: null, ...extra } })

  it('no banner when the API says none is due', () => {
    expect(newerLine(null)).toBeNull()
    expect(newerLine(spec({ state: 'CURRENT', banner: false }))).toBeNull()
  })

  it('a newer revision, a withdrawn one and every decision, with its tone and its words in both languages', () => {
    expect(newerLine(spec({}))).toEqual({ key: 'spec.banner.newer', params: { pinned: 2, newer: 3 }, tone: 'warning', newPages: false })
    expect(newerLine(spec({ state: 'WITHDRAWN', newer: null }))).toEqual({ key: 'spec.banner.withdrawn', params: { pinned: 2 }, tone: 'warning', newPages: false })
    for (const disposition of DISPOSITIONS) {
      const line = newerLine(spec({ newPages: disposition === 'REWORK', decision: { disposition, changeOrder: 'ECO-1' } }))!
      expect(line.key).toBe(`spec.banner.decided.${disposition}`)
      expect(line.tone).toBe(disposition === 'SCRAP' || disposition === 'HOLD' ? 'danger' : 'warning')
      expect(line.newPages).toBe(disposition === 'REWORK')
      for (const locale of LOCALES) expect(words(locale)[line.key], `${locale} ${line.key}`).toBeTruthy()
    }
    // Every state the API can say is one the screen handles (no banner, or one of the lines above).
    expect([...NEWER_SPEC_STATES].sort()).toEqual(['CURRENT', 'NEWER_RELEASED', 'NOT_RELEASED', 'NO_REVISION', 'WITHDRAWN'])
  })
})

describe('the spec for this size (PRD-258) and the spec problem (PRD-259)', () => {
  it('writes a measure, a material in the person’s language and the machine settings that are set', () => {
    expect(measureText({ min: '104', max: '108', unit: 'cm' })).toBe('104 – 108 cm')
    expect(measureText({ min: '64', max: '64', unit: 'cm' })).toBe('64 cm')
    expect(measureText({ min: null, max: '72', unit: null })).toBe('72')
    expect(measureText({ min: null, max: null, unit: 'cm' })).toBe('—')
    expect(measureText({ min: '64.5', max: '66', unit: 'cm' }, 'it')).toBe('64,5 – 66 cm')
    expect(decimalWords('1.85', 'it')).toBe('1,85')
    expect(decimalWords('2', 'en')).toBe('2')
    expect(decimalWords('3,5', 'it')).toBe('3,5')
    expect(materialName({ code: 'A', name: 'Pelle', nameI18n: { en: 'Leather', it: ' ' } }, 'en')).toBe('Leather')
    expect(materialName({ code: 'A', name: 'Pelle', nameI18n: { en: 'Leather', it: ' ' } }, 'it')).toBe('Pelle')
    const rows = settingRows(BASE.settings[0]!, 'en')
    expect(rows.map((row) => row.key)).toEqual(['machine', 'stitchType', 'needle', 'thread', 'stitchesPerCm', 'foot'])
    expect(rows[0]!.value).toBe('Lockstitch')
    for (const locale of LOCALES) for (const key of ['machine', 'stitchType', 'needle', 'thread', 'stitchesPerCm', 'tension', 'foot', 'notes']) expect(words(locale)[`spec.setting.${key}`], `${locale} ${key}`).toBeTruthy()
  })

  it('Send waits for a tile, and words for "Other"; the body names the work, never a person', () => {
    expect(sendHeld(EMPTY_PROBLEM)).toBe('tile')
    expect(sendHeld({ ...EMPTY_PROBLEM, problem: 'OTHER' })).toBe('detail')
    expect(sendHeld({ ...EMPTY_PROBLEM, problem: 'OTHER', note: 'La tacca manca' })).toBeNull()
    expect(sendHeld({ ...EMPTY_PROBLEM, problem: 'UNCLEAR', busy: true })).toBe('busy')
    expect(problemBody(BASE, EMPTY_PROBLEM)).toBeNull()
    const body = problemBody(BASE, { ...EMPTY_PROBLEM, problem: 'WRONG_MEASUREMENT', note: `  ${'x'.repeat(PROBLEM_NOTE_MAX + 20)}  ` })!
    expect(Object.keys(body).sort()).toEqual(['bundleId', 'note', 'problem', 'workOrderId', 'workOrderOperationId'])
    expect((body.note as string).length).toBe(PROBLEM_NOTE_MAX)
    expect(problemBody(BASE, { ...EMPTY_PROBLEM, problem: 'UNCLEAR', note: '   ' })).not.toHaveProperty('note')
    expect(photoName(BASE)).toBe('WO-DEMO-0042-op20-spec-problem.jpg')
  })

  it('every tile of the domain has words, and the queue kinds have their "what"', () => {
    for (const locale of LOCALES) {
      for (const problem of FLOOR_PROBLEMS) expect(words(locale)[`problem.kind.${problem}`], `${locale} ${problem}`).toBeTruthy()
      for (const due of ACK_DUE) {
        expect(words(locale)[`due.${due}`]).toBeTruthy()
        expect(words(locale)[`head.due.${due}`]).toBeTruthy()
        expect(words(locale)[`op.new.${due}`]).toBeTruthy()
      }
    }
    expect(QUEUED_ACTIONS['production.instruction.ack'].permission).toBe('production.scan')
    expect(QUEUED_ACTIONS['product.change.report'].permission).toBe('floor.work')
    expect(whatKeyOf('production.instruction.ack')).toBe('instructionSeen')
    expect(whatKeyOf('product.change.report')).toBe('specProblem')
  })
})

describe('what the tablet keeps for the visit', () => {
  it('an instruction under the code asked and the bundle’s own; another person forgets it; Seen and the Start opening per person', () => {
    forPerson('worker-a')
    keepInstruction('cp-123', null, BASE)
    expect(keptInstruction('CP-123', null)?.value.bundle.id).toBe('b-123')
    expect(keptInstruction(BASE.bundle.code, BASE.operation.id)?.value.operation.seq).toBe(20)
    markSeen('worker-a', VERSION)
    markOpenedBeforeStart('worker-a', VERSION)
    expect(seenHere('worker-a')(VERSION)).toBe(true)
    expect(seenHere('worker-b')(VERSION)).toBe(false)
    expect(seenHere(null)(VERSION)).toBe(false)
    expect(openedBeforeStart('worker-a')(VERSION)).toBe(true)
    expect(openedBeforeStart('worker-b')(VERSION)).toBe(false)
    forPerson('worker-b')
    expect(keptInstruction(BASE.bundle.code, BASE.operation.id)).toBeNull()
  })

  it('the hand-over is taken once', () => {
    offerInstructions({ code: 'BN-1', operationId: 'op-1', from: 'operation' })
    expect(takeInstructionsOffer()).toEqual({ code: 'BN-1', operationId: 'op-1', from: 'operation' })
    expect(takeInstructionsOffer()).toBeNull()
  })
})

describe('the Operation screen’s read and Start hook (FI9:01)', () => {
  const NEWER: NewerSpec = { workOrder: { id: 'wo-42', number: 'WO-DEMO-0042' }, revision: { revision: 2, status: 'RELEASED' }, newer: { state: 'CURRENT', banner: false, newPages: false, message: '', newer: null, decision: null } }
  const fakeApi = (paths: Record<string, unknown>): ApiClient =>
    ({
      get: async (path: string, options: { schema: { parse: (value: unknown) => unknown } }) => {
        if (!(path in paths)) throw new Error(`unexpected ${path}`)
        return options.schema.parse(paths[path])
      },
    }) as unknown as ApiClient

  it('reads the instruction and the newer-spec banner, keeps them, and gives the card its flag; offline, what was kept', async () => {
    forPerson('worker-c')
    const api = fakeApi({ '/production/instructions/floor/operation': BASE, '/production/work-orders/wo-42/spec/newer': { spec: NEWER } })
    const online = await readInstructionParts(api, { code: BASE.bundle.code, workOrderId: 'wo-42', operationId: 'op-20', online: true, workerId: 'worker-c' })
    expect(online.instruction?.due).toBe('FIRST')
    expect(online.newerSpec?.newer.state).toBe('CURRENT')
    const offline = await readInstructionParts(fakeApi({}), { code: BASE.bundle.code, workOrderId: 'wo-42', operationId: 'op-20', online: false, workerId: 'worker-c' })
    expect(offline.instruction?.versionNumber).toBe(4)
    expect(offline.newerSpec?.newer.state).toBe('CURRENT')
    // Start opens it once for this person; Seen here makes it no longer new.
    expect(startOpensInstruction(online.instruction, 'worker-c')).toBe(true)
    markOpenedBeforeStart('worker-c', VERSION)
    expect(startOpensInstruction(online.instruction, 'worker-c')).toBe(false)
    markSeen('worker-c', VERSION)
    expect(shownFlag(online.instruction, 'worker-c')?.due).toBeNull()
  })

  it('a bundle never opened offline has no flag (unknown), and a 401 says the session ended', async () => {
    forPerson('worker-d')
    const unknown = await readInstructionParts(fakeApi({}), { code: 'BN-NEW', workOrderId: 'wo-9', operationId: 'op-9', online: false, workerId: 'worker-d' })
    expect('instruction' in unknown).toBe(false)
    const { ApiError } = await import('../../../lib/api/errors')
    const signedOut = { get: async () => Promise.reject(new ApiError('signed_out', 401, 'unauthorized', 'x')) } as unknown as ApiClient
    expect((await readInstructionParts(signedOut, { code: 'BN-1', workOrderId: 'wo-1', operationId: 'op-1', online: true, workerId: 'worker-d' })).signedOut).toBe(true)
  })
})

describe('the tile, the page and the catalogue', () => {
  it('a tile at every station mode but the warehouse, asking production.scan, held by the notice; its page is held offline', () => {
    const all = ['floor.work', 'production.scan']
    for (const mode of ['sewing', 'cutting', 'packing', 'inspection'] as const) expect(homeTiles(mode, all, false).map((tile) => tile.key), mode).toContain('instructions')
    expect(homeTiles('warehouse', all, false).map((tile) => tile.key)).not.toContain('instructions')
    expect(homeTiles('sewing', ['floor.work'], false).map((tile) => tile.key)).not.toContain('instructions')
    expect(homeTiles('sewing', all, true).find((tile) => tile.key === 'instructions')?.held).toBe('notice')
    expect(TASK_ROUTES.instructions).toBe('/floor/instructions')
    expect(FLOOR_PAGES).toContain('/floor/instructions')
    expect(FLOOR_NAMESPACES).toContain('floor-instructions')
  })

  it('the catalogue has the same keys in it and en, with the same placeholders', () => {
    const it = words('it')
    const en = words('en')
    expect(Object.keys(it).sort()).toEqual(Object.keys(en).sort())
    const holes = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort()
    for (const key of Object.keys(en)) expect(holes(it[key]!), key).toEqual(holes(en[key]!))
  })
})

// ---- SCR-288: the parts on Operation and My work ----------------------------------------------------------------------------

const TOP = [...new Set(FLOOR_NAMESPACES.flatMap((namespace) => Object.keys(CATALOGUE.en[namespace] ?? {}).map((key) => key.split('.')[0]!)))]
const LEFT_KEY = new RegExp(`(?:^|[\\s>"])(?:${TOP.join('|')})\\.[a-zA-Z]+(?:\\.[a-zA-Z_]+)*`)

function render(screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, FLOOR_NAMESPACES) }, createElement(View, { model })))
}

describe('SCR-288 draws in both languages', () => {
  for (const locale of LOCALES) {
    it(`${elsewhereScreen.cases.length} cases in ${locale}: no key left, the W2b-4 parts on screen, never money`, () => {
      for (const item of elsewhereScreen.cases) {
        const html = render(elsewhereScreen as DesignScreen<unknown>, item.model, locale)
        expect(html.match(LEFT_KEY)?.[0] ?? null, `${item.id} (${locale})`).toBeNull()
        const text = html.replace(/<[^>]+>/g, ' ')
        expect(text.match(/€|EUR\s?\d|\$\s?\d/)?.[0] ?? null, item.id).toBeNull()
        const w = words(locale)
        if (item.id.startsWith('mywork')) expect(text, item.id).toContain(w['mywork.tile'])
        else expect(text, item.id).toContain(w[['op-new-first', 'op-new-changed', 'op-spec-hold'].includes(item.id) ? 'op.instructionsNew' : 'op.instructions'])
      }
    })
  }
})
