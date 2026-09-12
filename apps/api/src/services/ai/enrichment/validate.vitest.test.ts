/**
 * PES.8 — the validator is the gate between "the model said it" and "we offered
 * it to the operator". The case that matters most is the byte cap: it is the
 * one the existing generator has never checked, and it is the one an Italian
 * or German catalogue trips over while every character count still reads green.
 */
import { describe, expect, it } from 'vitest'

import type { CellConstraint } from './constraints.js'
import { byteLength, isOfferable, validateDraftValue } from './validate.js'

const col = (over: Partial<CellConstraint> = {}): CellConstraint => ({
  columnKey: 'item_name',
  writeField: 'name',
  label: 'Title',
  kind: 'text',
  requiredBy: [],
  ...over,
})

describe('validateDraftValue', () => {
  it('passes a value inside both caps', () => {
    const v = validateDraftValue('A perfectly ordinary title', col({ maxLength: 200, maxBytes: 200 }))
    expect(v).toEqual([])
    expect(isOfferable(v)).toBe(true)
  })

  it('catches an over-length value and reports both numbers', () => {
    const v = validateDraftValue('x'.repeat(205), col({ maxLength: 200, capFrom: 'Amazon IT' }))
    expect(v).toHaveLength(1)
    expect(v[0].kind).toBe('over_max_length')
    expect(v[0].severity).toBe('error')
    expect(v[0].actual).toBe(205)
    expect(v[0].limit).toBe(200)
    expect(v[0].message).toContain('Amazon IT')
    expect(isOfferable(v)).toBe(false)
  })

  it('catches a value that fits the CHARACTER cap but busts the BYTE cap', () => {
    // 150 accented characters: 150 chars, 300 UTF-8 bytes. A character-only
    // check calls this fine and Amazon refuses it at publish.
    const accented = 'à'.repeat(150)
    expect(accented.length).toBe(150)
    expect(byteLength(accented)).toBe(300)

    const c = col({ maxLength: 200, maxBytes: 200, capFrom: 'Amazon IT' })
    const v = validateDraftValue(accented, c)
    expect(v.map((x) => x.kind)).toEqual(['over_max_bytes'])
    expect(v[0].actual).toBe(300)
    expect(isOfferable(v)).toBe(false)
  })

  it('warns but does not block an off-list value on a strict column', () => {
    const c = col({ kind: 'select', options: ['Leather', 'Textile'], mode: 'strict' })
    const v = validateDraftValue('Cordura', c)
    expect(v).toHaveLength(1)
    expect(v[0].kind).toBe('off_list')
    expect(v[0].severity).toBe('warn')
    // The eBay flat file taught this: a published enum is routinely behind
    // what the channel accepts, so an off-list value stays offerable.
    expect(isOfferable(v)).toBe(true)
  })

  it('says nothing about an off-list value on an open column', () => {
    const c = col({ kind: 'select', options: ['Leather'], mode: 'open' })
    expect(validateDraftValue('Cordura', c)).toEqual([])
  })

  it('matches a listed option case-insensitively but flags a deprecated one', () => {
    const c = col({ kind: 'select', options: ['Leather', 'Textile'], mode: 'strict', deprecatedOptions: ['Textile'] })
    expect(validateDraftValue('leather', c)).toEqual([])
    const v = validateDraftValue('TEXTILE', c)
    expect(v.map((x) => x.kind)).toEqual(['deprecated_option'])
    expect(isOfferable(v)).toBe(true)
  })

  it('applies the cap to every member of a list value', () => {
    const c = col({ columnKey: 'bullet_point', writeField: 'bulletPoints', maxLength: 20 })
    const v = validateDraftValue(['short', 'x'.repeat(30), 'also short'], c)
    expect(v).toHaveLength(1)
    expect(v[0].kind).toBe('over_max_length')
    expect(v[0].message).toContain('item 2')
  })

  it('refuses empty, missing and wrong-typed values', () => {
    expect(validateDraftValue(null, col())[0].kind).toBe('empty')
    expect(validateDraftValue('   ', col())[0].kind).toBe('empty')
    expect(validateDraftValue([], col())[0].kind).toBe('empty')
    expect(validateDraftValue({ nope: 1 }, col())[0].kind).toBe('wrong_type')
  })

  it('never repairs a value — a violation is reported, not trimmed', () => {
    // The function returns findings only; there is no path by which it can
    // hand back a shortened string. If this ever changes, the operator would
    // be reviewing copy the model did not write.
    const long = 'x'.repeat(300)
    const v = validateDraftValue(long, col({ maxLength: 200 }))
    expect(v[0].actual).toBe(300)
    expect(long).toHaveLength(300)
  })
})
