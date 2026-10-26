import { describe, expect, it } from 'vitest'
import { charactersOver, countCharacters, counterWords, overWords, textareaCount } from './textareaCounter'

describe('countCharacters — what a person sees', () => {
  it('counts plain text', () => {
    expect(countCharacters('Grazie Marco')).toBe(12)
    expect(countCharacters('')).toBe(0)
    expect(countCharacters(null)).toBe(0)
  })
  it('counts an emoji or a combined letter as one character', () => {
    expect(countCharacters('👍🏽')).toBe(1)
    expect(countCharacters('é')).toBe(1)
    expect(countCharacters('👨‍👩‍👧 ok')).toBe(4)
  })
})

describe('limit words', () => {
  it('says the count against the limit', () => {
    expect(counterWords(312, 500)).toBe('312 / 500')
    expect(counterWords(1200, 5000)).toBe('1,200 / 5,000')
  })
  it('says how much is too long', () => {
    expect(overWords(38)).toBe('38 characters too long')
    expect(overWords(1)).toBe('1 character too long')
    expect(charactersOver(538, 500)).toBe(38)
    expect(charactersOver(12, 500)).toBe(0)
    expect(charactersOver(12, null)).toBe(0)
  })
  it('puts both in the counter, and lets the caller word the count', () => {
    expect(textareaCount('a'.repeat(312), 500)).toEqual({ used: 312, over: 0, text: '312 / 500' })
    expect(textareaCount('a'.repeat(538), 500)).toEqual({ used: 538, over: 38, text: '538 / 500 · 38 characters too long' })
    expect(textareaCount('abc', 10, (u, l) => `${l - u} left`).text).toBe('7 left')
  })
})
