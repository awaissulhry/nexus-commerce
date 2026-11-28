import { describe, expect, it } from 'vitest'
import en from '../../../../messages/en/floor-help2.json'
import it_ from '../../../../messages/it/floor-help2.json'
import { newestFirst, notesSpeech } from '../notes/model'
import { PHOTO_NOTE_KIND, photoHeld, photoNotePayload } from '../photo/model'
import { answerPayload, raisePayload } from './api'
import { askTypes, BASKET_ID, flag, helpRead, problemTypes } from './fixtures'
import {
  ASK_CODES,
  askStateKey,
  askTo,
  CARD_TONE,
  cardStateOf,
  cardWordsKey,
  leaderButtons,
  mediaHeld,
  mediaName,
  needsDepartment,
  pickOutcome,
  PROBLEM_CODES,
  raiseOutcome,
  spotPlace,
  spotShown,
  tilesOf,
  voiceSeconds,
  workerCanSolve,
} from './model'

/** A word of the catalogue by its path (`card.state.TOLD`). */
const word = (catalogue: unknown, path: string): string => path.split('.').reduce<unknown>((node, key) => (node as Record<string, unknown>)[key], catalogue) as string

const raised = (bundle: { id: string; code: string } | null, existing: boolean) => ({ kept: null, answer: { ok: true as const, value: { call: { id: 'call-9', status: 'SENT', bundle }, existing } } })

describe('owb-fl8 — the red card of a problem (Told → The team leader comes → Solved)', () => {
  it('walks Told → The team leader comes → Solved, and says "at the office" after its time only while nobody comes', () => {
    expect(cardStateOf(flag({ state: 'SENT' }))).toBe('TOLD')
    expect(cardStateOf(flag({ state: 'SEEN' }))).toBe('COMES')
    expect(cardStateOf(flag({ state: 'ON_THE_WAY' }))).toBe('COMES')
    expect(cardStateOf(flag({ state: 'SOLVED' }))).toBe('SOLVED')
    // The escalation job set `escalated`: the told call is at the office now …
    expect(cardStateOf(flag({ state: 'SENT', escalated: true }))).toBe('OFFICE')
    // … but someone on the way wins (the design's probState), and a solved one stays solved.
    expect(cardStateOf(flag({ state: 'ON_THE_WAY', escalated: true }))).toBe('COMES')
    expect(cardStateOf(flag({ state: 'SOLVED', escalated: true }))).toBe('SOLVED')
    expect(cardStateOf(flag({ state: 'CANCELLED' }))).toBeNull()
    expect(cardStateOf(null)).toBeNull()
  })

  it('says each state in words, the escalated one as "It is at the office now", and a lost page as the office\'s print', () => {
    expect(word(en, cardWordsKey('TOLD', 'MATERIAL'))).toBe('Told')
    expect(word(en, cardWordsKey('COMES', 'MATERIAL'))).toBe('The team leader comes')
    expect(word(en, cardWordsKey('OFFICE', 'MATERIAL'))).toBe('It is at the office now')
    expect(word(en, cardWordsKey('SOLVED', 'MATERIAL'))).toBe('Solved')
    expect(word(en, cardWordsKey('TOLD', 'PAPER'))).toBe('The office prints it again')
    expect(word(en, cardWordsKey('SOLVED', 'PAPER'))).toBe('Solved')
    for (const state of ['TOLD', 'COMES', 'OFFICE', 'SOLVED'] as const) expect(word(it_, cardWordsKey(state, 'MACHINE'))).toBeTruthy()
    // Never colour alone: each state has a tone AND its icon and words on the card.
    expect(CARD_TONE).toEqual({ TOLD: 'warning', COMES: 'info', OFFICE: 'danger', SOLVED: 'success' })
  })

  it('gives the team leader On my way while nobody comes, then Solved; the worker only Solved, and nothing on a solved call', () => {
    expect(leaderButtons(flag({ state: 'SENT' }))).toEqual(['ON_THE_WAY', 'SOLVED'])
    expect(leaderButtons(flag({ state: 'SENT', escalated: true }))).toEqual(['ON_THE_WAY', 'SOLVED'])
    expect(leaderButtons(flag({ state: 'ON_THE_WAY' }))).toEqual(['SOLVED'])
    expect(leaderButtons(flag({ state: 'SOLVED' }))).toEqual([])
    expect(workerCanSolve(flag({ state: 'SEEN' }))).toBe(true)
    expect(workerCanSolve(flag({ state: 'SOLVED' }))).toBe(false)
    expect(answerPayload('call-1', 'ON_THE_WAY')).toEqual({ callId: 'call-1', step: 'ON_THE_WAY' })
  })

  it('offers the place only where the read carries it, and puts the spot in the middle of its ninth', () => {
    expect(spotShown(flag())).toBe(false)
    expect(spotShown(flag({ spot: null }))).toBe(true)
    expect(spotShown(flag({ spot: 4 }))).toBe(true)
    expect(spotShown(null)).toBe(false)
    expect(spotPlace(0).left).toBeCloseTo(16.67)
    expect(spotPlace(0).top).toBeCloseTo(16.67)
    expect(spotPlace(4).left).toBeCloseTo(50)
    expect(spotPlace(4).top).toBeCloseTo(50)
    expect(spotPlace(8).left).toBeCloseTo(83.33)
  })
})

describe('owb-fl8 — one tap tells it', () => {
  it('answers "Already told for B-0412" when the station\'s open call of the type is for another basket (settle 4)', () => {
    const outcome = raiseOutcome(raised({ id: 'another-bundle', code: 'B-0412' }, true), BASKET_ID)
    expect(outcome).toEqual({ kind: 'already', callId: 'call-9', basketCode: 'B-0412' })
    expect(word(en, 'window.already').replace('{code}', 'B-0412')).toBe('Already told for B-0412: the team leader comes.')
    // This basket's own open call, or a new one: told.
    expect(raiseOutcome(raised({ id: BASKET_ID, code: 'B-0431' }, true), BASKET_ID)).toEqual({ kind: 'told', callId: 'call-9' })
    expect(raiseOutcome(raised({ id: 'another-bundle', code: 'B-0412' }, false), BASKET_ID)).toEqual({ kind: 'told', callId: 'call-9' })
  })

  it('keeps it on the phone with no network, under the client id of the try', () => {
    expect(raiseOutcome({ kept: { clientEventId: 'ev-1' }, answer: null }, BASKET_ID)).toEqual({ kind: 'saved', clientEventId: 'ev-1' })
  })

  it('sends the type, the basket and its work order (the station and the person are the phone\'s session)', () => {
    expect(raisePayload('type-material', helpRead())).toEqual({ typeId: 'type-material', bundleId: BASKET_ID, workOrderId: '00000000-0000-4000-8000-00000000a001' })
  })
})

describe('owb-fl8 — a problem without a department pick asks for it first (settle 3)', () => {
  it('opens on the department pick while the phone has none, and on the tiles once picked', () => {
    expect(needsDepartment(helpRead({ here: { departmentId: null } }))).toBe(true)
    expect(needsDepartment(helpRead({ here: { departmentId: null } }), true)).toBe(false)
    expect(needsDepartment(helpRead())).toBe(false)
  })

  it('turns a NO_STATION refusal into the pick, in words: "Pick your department first."', () => {
    const refused = { kept: null, answer: { ok: false as const, problem: { kind: 'refused' as const, code: 'NO_STATION', message: 'No station', fix: null } } }
    expect(raiseOutcome(refused, BASKET_ID)).toEqual({ kind: 'department' })
    expect(word(en, 'window.noStation')).toBe('Pick your department first.')
    const other = { kept: null, answer: { ok: false as const, problem: { kind: 'refused' as const, code: 'TYPE_INACTIVE', message: 'Not active', fix: null } } }
    expect(raiseOutcome(other, BASKET_ID).kind).toBe('problem')
  })

  it('takes one station, lists several once, and says it in words when the department has none', () => {
    expect(pickOutcome({ station: { id: 's1', name: 'Cutting 1' }, choose: [] })).toEqual({ kind: 'taken' })
    expect(pickOutcome({ station: null, choose: [{ id: 's1', name: 'Cutting 1' }, { id: 's2', name: 'Cutting 2' }] })).toEqual({ kind: 'choose', stations: [{ id: 's1', name: 'Cutting 1' }, { id: 's2', name: 'Cutting 2' }] })
    expect(pickOutcome({ station: null, choose: [] })).toEqual({ kind: 'none' })
    expect(word(en, 'department.none')).toBe('This department has no station at this site. Ask the office to add one.')
  })
})

describe('owb-fl8 — the tiles and who answers an ask (settle 5)', () => {
  it('lists the site\'s ACTIVE types of the five problem codes in the design\'s order, never another code', () => {
    expect(tilesOf(problemTypes, PROBLEM_CODES)).toEqual([
      { code: 'MATERIAL', typeId: 'type-material' },
      { code: 'PAPER', typeId: 'type-paper' },
    ])
    expect(tilesOf([], PROBLEM_CODES)).toEqual([])
    expect(tilesOf(askTypes, ASK_CODES).map((tile) => tile.code)).toEqual(['ASK_LOGO', 'ASK_OTHER'])
  })

  it('fixes who answers by the code: logo, patch, unclear → designer; to the patch team, something else → team leader', () => {
    expect(ASK_CODES.map((code) => [code, askTo(code)])).toEqual([
      ['ASK_LOGO', 'DESIGNER'],
      ['ASK_PATCH', 'DESIGNER'],
      ['ASK_TO_PATCH', 'TEAM_LEADER'],
      ['ASK_UNCLEAR', 'DESIGNER'],
      ['ASK_OTHER', 'TEAM_LEADER'],
    ])
    expect(askStateKey(flag({ state: 'SENT' }))).toBe('ask.state.asked')
    expect(askStateKey(flag({ state: 'ON_THE_WAY' }))).toBe('ask.state.taken')
    expect(askStateKey(flag({ state: 'SOLVED' }))).toBe('ask.state.answered')
  })

  it('has words for every code in both languages (the floor shows its own words, never the code)', () => {
    for (const code of PROBLEM_CODES) expect([word(en, `problem.code.${code}`), word(it_, `problem.code.${code}`)].every(Boolean)).toBe(true)
    for (const code of ASK_CODES) expect([word(en, `ask.code.${code}`), word(it_, `ask.code.${code}`)].every(Boolean)).toBe(true)
  })
})

describe('owb-fl8 — photo, voice and notes', () => {
  it('refuses the photo with no network, in words', () => {
    expect(photoHeld(false)).toBe('offline')
    expect(photoHeld(true)).toBeNull()
    expect(word(en, 'photo.offline')).toMatch(/^Needs the network/)
    expect(word(it_, 'photo.offline')).toMatch(/^Serve la rete/)
    expect(mediaHeld(false)).toBe('offline')
    expect(word(en, 'media.offline')).toBe('Needs the network')
  })

  it('sends the photo as today\'s floor note on the basket\'s work order, naming the uploaded file', () => {
    expect(PHOTO_NOTE_KIND).toBe('production.floorNote.post')
    expect(photoNotePayload(helpRead(), 'file-1')).toEqual({ workOrderId: '00000000-0000-4000-8000-00000000a001', tileCode: 'OTHER', fileIds: ['file-1'], bundleId: BASKET_ID })
  })

  it('names a file by the basket and the time, never a person; a voice note is 1 to 120 seconds', () => {
    expect(mediaName('B-0431', 'photo', new Date('2026-11-28T09:05:07.000Z'), 'image/jpeg')).toBe('B-0431-photo-20261128090507.jpg')
    expect(mediaName('B-0431', 'voice', new Date('2026-11-28T09:05:07.000Z'), 'audio/webm;codecs=opus')).toBe('B-0431-voice-20261128090507.webm')
    expect(voiceSeconds(7.4, 60)).toBe(7)
    expect(voiceSeconds(Number.POSITIVE_INFINITY, 12)).toBe(12)
    expect(voiceSeconds(0, 0)).toBe(1)
    expect(voiceSeconds(400, 60)).toBe(120)
  })

  it('shows the office\'s notes newest first and reads them aloud in that order', () => {
    const notes = [
      { at: '2026-11-27T08:00:00.000Z', words: 'Old note', fileIds: [] },
      { at: '2026-11-28T08:00:00.000Z', words: 'New note', fileIds: ['f'] },
      { at: 'not a time', words: 'Unreadable time', fileIds: [] },
    ]
    expect(newestFirst(notes).map((note) => note.words)).toEqual(['New note', 'Old note', 'Unreadable time'])
    expect(notesSpeech(notes)).toBe('New note. Old note. Unreadable time')
  })
})
