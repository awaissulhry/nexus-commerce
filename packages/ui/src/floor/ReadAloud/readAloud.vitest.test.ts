import { createElement as h } from 'react'
import { renderToStaticMarkup as render } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ReadAloudButton } from './ReadAloudButton'
import { pickVoice, speechChunks, voiceLangScore } from './readAloudModel'

/** B-W2b-28 (D27) — read-aloud: a voice for the person's language, or no button. */
const VOICES = [
  { name: 'Daniel', lang: 'en-GB', default: true, localService: true },
  { name: 'Alice', lang: 'it-IT', localService: true },
  { name: 'Luca (online)', lang: 'it-IT', localService: false },
  { name: 'Svizzera', lang: 'it_CH' },
  { name: 'Ioana', lang: 'ro-RO' },
]

describe('pickVoice', () => {
  it('scores the same language and region over the same language, and another language as none', () => {
    expect(voiceLangScore('it-IT', 'it-it')).toBe(2)
    expect(voiceLangScore('it_CH', 'it-IT')).toBe(1)
    expect(voiceLangScore('en-GB', 'it')).toBe(0)
    expect(voiceLangScore('', 'it')).toBe(0)
  })
  it('picks the exact language first, a voice on the device among equals, the same language in another region next', () => {
    expect(pickVoice(VOICES, 'it-IT')?.name).toBe('Alice')
    expect(pickVoice(VOICES, 'it')?.name).toBe('Alice')
    expect(pickVoice(VOICES, 'it-CH')?.name).toBe('Svizzera')
    expect(pickVoice(VOICES, 'ro')?.name).toBe('Ioana')
  })
  it('has no voice for a language the device does not speak', () => {
    expect(pickVoice(VOICES, 'ur')).toBeNull()
    expect(pickVoice([], 'it')).toBeNull()
  })
})

describe('speechChunks', () => {
  it('reads sentence by sentence and cuts a long sentence at a space', () => {
    expect(speechChunks('Leggi qui. Poi tocca Avanti!  Fatto?')).toEqual(['Leggi qui.', 'Poi tocca Avanti!', 'Fatto?'])
    const long = `${'parola '.repeat(40)}fine.`
    const pieces = speechChunks(long, 60)
    expect(pieces.every((p) => p.length <= 60)).toBe(true)
    expect(pieces.join(' ')).toBe(long.replace(/\s+/g, ' ').trim())
    expect(speechChunks('   ')).toEqual([])
  })
})

describe('ReadAloudButton', () => {
  it('draws nothing on the server: the voices are not known there, and no voice means no button', () => {
    expect(render(h(ReadAloudButton, { text: 'Ciao', lang: 'it-IT' }))).toBe('')
  })
})
