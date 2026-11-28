import { afterEach, describe, expect, it } from 'vitest'
import en from '../../../messages/en/floor-help2.json'
import { PROFILE_PATH, SUGGESTION_KIND, profileSchema } from './api'
import { floorLanguages, mayQueueSuggestion, NEW_SUGGESTION, netStripShown, roleOf, savedHere, suggestionHeld, suggestionPayload } from './model'
import { DEFAULT_SETTINGS, floorSettings, readSettings, resetFloorSettings, setFloorSetting, SETTINGS_KEY } from './settings'

const word = (path: string): string => path.split('.').reduce<unknown>((node, key) => (node as Record<string, unknown>)[key], en) as string

describe('owb-fl8 — Tell the office', () => {
  it('sends a suggestion "without my name" with withName:false and nothing that names the worker', () => {
    const payload = suggestionPayload({ kind: 'WRONG', words: '  The light at table 3 is broken.  ', voice: null }, false, null)
    expect(payload).toEqual({ kind: 'WRONG', words: 'The light at table 3 is broken.', withName: false })
    expect(Object.keys(payload)).not.toContain('workerId')
    expect(Object.keys(payload)).not.toContain('employeeId')
    expect(suggestionPayload({ kind: 'IDEA', words: '', voice: null }, true, 'file-9')).toEqual({ kind: 'IDEA', voiceFileId: 'file-9', withName: true })
  })

  it('never lets a suggestion without the name wait on the phone; a named one may (server B: ANON_ONLINE)', () => {
    expect(mayQueueSuggestion(false)).toBe(false)
    expect(mayQueueSuggestion(true)).toBe(true)
    const draft = { kind: 'THANKS' as const, words: '', voice: null }
    expect(suggestionHeld(draft, false, false)).toBe('anonOffline')
    expect(suggestionHeld(draft, false, true)).toBeNull()
    expect(word('tell.held.anonOffline')).toBe('A message without your name goes only when the network is there.')
    expect(SUGGESTION_KIND).toBe('floor.suggestion')
  })

  it('asks what it is about first; an idea or a wrong thing says what; a thank you may go alone; a voice note needs the network', () => {
    expect(suggestionHeld(NEW_SUGGESTION, true, true)).toBe('kind')
    expect(suggestionHeld({ kind: 'IDEA', words: ' ', voice: null }, true, true)).toBe('empty')
    expect(suggestionHeld({ kind: 'THANKS', words: '', voice: null }, true, false)).toBeNull()
    const voice = { blob: new Blob(['x'], { type: 'audio/webm' }), seconds: 4 }
    expect(suggestionHeld({ kind: 'IDEA', words: '', voice }, true, true)).toBeNull()
    expect(suggestionHeld({ kind: 'IDEA', words: '', voice }, false, true)).toBe('voiceOffline')
  })
})

describe('owb-fl8 — the Me page', () => {
  it('reads the profile from its own route (GET /floor/me stays the operator FloorApp reads)', () => {
    expect(PROFILE_PATH).toBe('/floor/me/profile')
    const parsed = profileSchema.parse({ subject: 'WORKER', team: { id: 't1', name: 'Team Blue' }, leader: { name: null }, departments: [{ id: 'd2', number: 2, name: 'Cutting', shortName: 'Cutting', tone: 'orange', icon: 'scissors', nameI18n: null }], departmentsFrom: 'SKILLS', doneToday: null, locale: 'en', floorLocales: ['it', 'en'] })
    expect(parsed.team?.name).toBe('Team Blue')
    expect(parsed.leader?.name).toBeNull()
  })

  it('says worker or team leader by today\'s right, never a score', () => {
    expect(roleOf(['floor.work', 'floor.lead'])).toBe('LEADER')
    expect(roleOf(['floor.work'])).toBe('WORKER')
  })

  it('offers the site\'s floor languages this web speaks, in the site\'s order, never a raw tag', () => {
    expect(floorLanguages(['en', 'it', 'xx', 'en'])).toEqual(['en', 'it'])
    expect(floorLanguages([])).toEqual([])
  })

  it('counts this person\'s actions saved on this phone, and shows the strip only offline or while something waits', () => {
    const item = (workerId: string, state: string, final = false) => ({ workerId, state, refusal: state === 'refused' ? { id: null, code: 'X', message: 'm', fix: 'f', final } : null }) as never
    expect(savedHere([item('w1', 'waiting'), item('w1', 'recorded'), item('w2', 'waiting'), item('w1', 'refused'), item('w1', 'refused', true)], 'w1')).toBe(2)
    expect(savedHere([item('w1', 'waiting')], null)).toBe(0)
    expect(netStripShown(true, 0)).toBe(false)
    expect(netStripShown(true, 2)).toBe(true)
    expect(netStripShown(false, 0)).toBe(true)
  })
})

describe('owb-fl8 — Large words and Sound live on this phone only', () => {
  afterEach(() => resetFloorSettings())

  it('reads a broken or missing value as the default (sound on, normal words)', () => {
    expect(readSettings(null)).toEqual(DEFAULT_SETTINGS)
    expect(readSettings('{not json')).toEqual(DEFAULT_SETTINGS)
    expect(readSettings('{"large":true,"sound":false}')).toEqual({ large: true, sound: false })
  })

  it('keeps a change in the device storage and nowhere else; a failing storage keeps it for this visit', () => {
    const kept = new Map<string, string>()
    const storage = { getItem: (key: string) => kept.get(key) ?? null, setItem: (key: string, value: string) => void kept.set(key, value) }
    expect(setFloorSetting('large', true, storage)).toEqual({ large: true, sound: true })
    expect(JSON.parse(kept.get(SETTINGS_KEY)!)).toEqual({ large: true, sound: true })
    resetFloorSettings()
    const broken = { getItem: () => null, setItem: () => { throw new Error('blocked') } }
    expect(setFloorSetting('sound', false, broken)).toEqual({ large: false, sound: false })
    expect(floorSettings(broken)).toEqual({ large: false, sound: false })
  })
})
