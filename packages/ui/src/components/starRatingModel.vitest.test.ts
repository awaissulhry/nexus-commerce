import { describe, expect, it } from 'vitest'
import {
  clampRating, ratingCountWords, starChoiceWords, starFills, starInputValue, starKeyTarget, starTabStop, starWords,
} from './starRatingModel'

const drawn = (value: number | null, max?: number) => starFills(value, max).map(f => (f === 'full' ? '★' : f === 'half' ? '½' : '·')).join('')

describe('starFills — round DOWN to the nearest half', () => {
  it('draws whole stars, then a half for a remainder of a half or more', () => {
    expect(drawn(4.3)).toBe('★★★★·')
    expect(drawn(4.7)).toBe('★★★★½')
    expect(drawn(4.5)).toBe('★★★★½')
    expect(drawn(4.49)).toBe('★★★★·')
    expect(drawn(5)).toBe('★★★★★')
    expect(drawn(0)).toBe('·····')
  })
  it('draws no rating as five empty stars, never as a value', () => {
    expect(drawn(null)).toBe('·····')
    expect(drawn(Number.NaN)).toBe('·····')
  })
  it('clamps above max and below zero', () => {
    expect(drawn(7)).toBe('★★★★★')
    expect(drawn(-2)).toBe('·····')
    expect(clampRating(7)).toBe(5)
    expect(clampRating(null)).toBeNull()
  })
  it('follows max', () => {
    expect(drawn(2.5, 3)).toBe('★★½')
    expect(starFills(1, 10)).toHaveLength(10)
  })
})

describe('starWords', () => {
  it('names the real number to one decimal', () => {
    expect(starWords(4.5)).toBe('4.5 out of 5 stars')
    expect(starWords(4.33)).toBe('4.3 out of 5 stars')
    expect(starWords(4)).toBe('4 out of 5 stars')
    expect(starWords(9)).toBe('5 out of 5 stars')
  })
  it('says No rating for null', () => {
    expect(starWords(null)).toBe('No rating')
  })
})

describe('count and choice words', () => {
  it('counts ratings in words', () => {
    expect(ratingCountWords(1)).toBe('1 rating')
    expect(ratingCountWords(0)).toBe('0 ratings')
    expect(ratingCountWords(1284)).toBe('1,284 ratings')
  })
  it('names each input star', () => {
    expect(starChoiceWords(1)).toBe('1 star')
    expect(starChoiceWords(4)).toBe('4 stars')
  })
})

describe('input mode', () => {
  it('holds a whole star and gives Tab to it (or the first)', () => {
    expect(starInputValue(3.6)).toBe(4)
    expect(starInputValue(null)).toBe(0)
    expect(starTabStop(null)).toBe(1)
    expect(starTabStop(4)).toBe(4)
  })
  it('moves with the arrow keys, Home and End, and stops at the ends', () => {
    expect(starKeyTarget('ArrowRight', 3)).toBe(4)
    expect(starKeyTarget('ArrowUp', 5)).toBe(5)
    expect(starKeyTarget('ArrowLeft', 3)).toBe(2)
    expect(starKeyTarget('ArrowDown', 1)).toBe(1)
    expect(starKeyTarget('ArrowRight', 0)).toBe(1)
    expect(starKeyTarget('Home', 4)).toBe(1)
    expect(starKeyTarget('End', 2)).toBe(5)
    expect(starKeyTarget('Enter', 2)).toBeNull()
  })
})
