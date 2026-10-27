/**
 * Reviews › Settings — the voice + alerts draft: what counts as a change (the EditModeBar's count), Discard, the PUT
 * body (only what changed), and Save held with the first reason that applies.
 */
import { describe, expect, it } from 'vitest'
import {
  dirtyCount, formFromSettings, ratingDropWords, recipientsHint, saveHeldReason, setAlertOn, setAlertRecipients, setAvoidWords, setSignOff,
  setTone, settingsPayload, toggleAlertVia, toggleLanguage, type SettingsResponse,
} from './settingsForm'

const answer: Pick<SettingsResponse, 'voice' | 'alerts'> = {
  voice: { tone: 'NEUTRAL', languages: ['buyer'], signOff: null, avoidWords: ['cheap'] },
  alerts: [
    { key: 'negative', on: true, recipients: [], via: ['app'] },
    { key: 'digest', on: true, recipients: [{ userId: 'u1', name: 'Person one' }], via: ['email'] },
    { key: 'ratingDrop', on: false, recipients: [], via: ['app'] },
  ],
}

describe('the draft', () => {
  const saved = formFromSettings(answer)

  it('reads the answer: no sign-off is an empty field, recipients are ids', () => {
    expect(saved.voice.signOff).toBe('')
    expect(saved.alerts[1].recipients).toEqual(['u1'])
  })

  it('counts each changed setting once; undoing a change takes it off the count', () => {
    let d = setTone(saved, 'WARM')
    d = toggleLanguage(d, 'it', true)
    d = setSignOff(d, 'The care team')
    expect(dirtyCount(saved, d)).toBe(3)
    d = toggleLanguage(d, 'it', false)
    expect(dirtyCount(saved, d)).toBe(2)
    d = setAlertOn(d, 'digest', false)
    d = toggleAlertVia(d, 'negative', 'email', true)
    d = setAlertRecipients(d, 'negative', ['u2', 'u2'])
    expect(dirtyCount(saved, d)).toBe(5)
    // Discard = the saved form again.
    expect(dirtyCount(saved, saved)).toBe(0)
  })

  it('a sign-off with only spaces added is no change; the same words to avoid in another case are one word', () => {
    expect(dirtyCount(saved, setSignOff(saved, '   '))).toBe(0)
    expect(setAvoidWords(saved, ['cheap', 'Cheap', ' refund ']).voice.avoidWords).toEqual(['cheap', 'refund'])
  })

  it('languages keep the list order whatever the order they were ticked in', () => {
    const d = toggleLanguage(toggleLanguage(saved, 'en', true), 'de', true)
    expect(d.voice.languages).toEqual(['buyer', 'de', 'en'])
  })
})

describe('the PUT body', () => {
  const saved = formFromSettings(answer)

  it('nothing changed → nothing to send', () => {
    expect(settingsPayload(saved, saved)).toBeNull()
  })

  it('the whole voice when any of it changed; only the alerts that changed', () => {
    const d = setAlertOn(setSignOff(saved, ' The care team '), 'digest', false)
    expect(settingsPayload(saved, d)).toEqual({
      voice: { tone: 'NEUTRAL', languages: ['buyer'], signOff: 'The care team', avoidWords: ['cheap'] },
      alerts: [{ key: 'digest', on: false, recipients: ['u1'], via: ['email'] }],
    })
  })

  it('an emptied sign-off is sent as none', () => {
    const withSignOff = formFromSettings({ ...answer, voice: { ...answer.voice, signOff: 'Team' } })
    expect(settingsPayload(withSignOff, setSignOff(withSignOff, ''))?.voice?.signOff).toBeNull()
  })
})

describe('Save held', () => {
  const saved = formFromSettings(answer)

  it('says the first problem', () => {
    expect(saveHeldReason(saved)).toBeNull()
    expect(saveHeldReason(toggleLanguage(saved, 'buyer', false))).toBe('Pick at least one reply language.')
    expect(saveHeldReason(setSignOff(saved, 'x'.repeat(81)))).toBe('Keep the sign-off to 80 characters (it has 81).')
    expect(saveHeldReason(toggleAlertVia(saved, 'negative', 'app', false))).toBe('Choose how “New negative review” arrives: in Nexus, by e-mail or both.')
    // Switched off, it needs no way to arrive.
    expect(saveHeldReason(setAlertOn(toggleAlertVia(saved, 'negative', 'app', false), 'negative', false))).toBeNull()
  })

  it('"Rating drop": switched on, it needs a way to arrive; on and how it arrives go in the PUT', () => {
    const on = setAlertOn(saved, 'ratingDrop', true)
    expect(saveHeldReason(on)).toBeNull()
    expect(saveHeldReason(toggleAlertVia(on, 'ratingDrop', 'app', false))).toBe('Choose how “Rating drop” arrives: in Nexus, by e-mail or both.')
    expect(saveHeldReason(toggleAlertVia(saved, 'ratingDrop', 'app', false))).toBeNull()
    expect(settingsPayload(saved, toggleAlertVia(on, 'ratingDrop', 'email', true))).toEqual({ alerts: [{ key: 'ratingDrop', on: true, recipients: [], via: ['app', 'email'] }] })
    expect(recipientsHint(on.alerts[2], [])).toBe('Nobody picked: the business’s owners get it.')
  })

  it('says who gets an alert when nobody is picked', () => {
    expect(recipientsHint(saved.alerts[0], [])).toBe('Nobody picked: the business’s owners get it.')
    expect(recipientsHint({ ...saved.alerts[1], recipients: [] }, ['care@example.test'])).toBe('Nobody picked: it goes to care@example.test, as today.')
    expect(recipientsHint(saved.alerts[1], [])).toBe('Goes to 1 person.')
  })
})

describe('"Rating drop" in words', () => {
  it('says the threshold, the windows, the minimum in each, what counts and how often, from the API’s rule', () => {
    expect(ratingDropWords({ recentDays: 7, beforeDays: 28, minRated: 5, dropAtLeast: 0.3, reopenAfterDays: 7 })).toEqual([
      'A product family’s average falls 0.3 stars or more in one market: the last 7 days against the 28 days before, with at least 5 rated reviews in each.',
      'Only product reviews with stars count: never seller feedback or eBay feedback, and Amazon only from imported reviews.',
      'Checked every hour. One alert per product and market until it is resolved; after a resolve, a new one opens only if the drop is still there 7 days later.',
    ])
    expect(ratingDropWords({ recentDays: 1, beforeDays: 1, minRated: 1, dropAtLeast: 0.5, reopenAfterDays: 1 })[0]).toBe(
      'A product family’s average falls 0.5 stars or more in one market: the last 1 day against the 1 day before, with at least 1 rated review in each.',
    )
  })
})
