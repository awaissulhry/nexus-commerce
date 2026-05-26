/**
 * FL.1.4 — Unit tests for the pure field-resolution core.
 *
 * Covers the precedence stack (locked > manual > linked > master >
 * default), cross-language translate flagging, empty-value fall-through,
 * and the manifest parentage reader. No DB — these are pure functions.
 */

import { describe, it, expect } from 'vitest'
import {
  resolveFieldValue,
  isEmptyValue,
} from '../field-resolution/resolveField.js'
import {
  parentageFromTags,
  parentageFromEbayAspect,
} from '../field-resolution/parentage.js'

describe('resolveFieldValue | precedence', () => {
  it('locked → always master, ignoring override + linked', () => {
    const r = resolveFieldValue({
      locked: true,
      master: 'Xavia',
      override: { value: 'TYPED' },
      linked: { value: 'LINKED' },
    })
    expect(r).toEqual({ value: 'Xavia', source: 'locked', needsTranslation: false })
  })

  it('manual override wins over linked + master', () => {
    const r = resolveFieldValue({
      override: { value: 'Pinned title' },
      linked: { value: 'Linked title' },
      master: 'Master title',
    })
    expect(r.value).toBe('Pinned title')
    expect(r.source).toBe('manual')
  })

  it('override keeps a non-manual source (ai / sibling)', () => {
    expect(resolveFieldValue({ override: { value: 'x', source: 'ai' } }).source).toBe('ai')
    expect(resolveFieldValue({ override: { value: 'x', source: 'sibling' } }).source).toBe('sibling')
  })

  it('linked wins over master when no override', () => {
    const r = resolveFieldValue({ linked: { value: 'Linked' }, master: 'Master' })
    expect(r.value).toBe('Linked')
    expect(r.source).toBe('linked')
  })

  it('master wins when no override + no linked', () => {
    const r = resolveFieldValue({ master: 'Master' })
    expect(r).toEqual({ value: 'Master', source: 'master', needsTranslation: false })
  })

  it('schema default is the last resort', () => {
    const r = resolveFieldValue({ schemaDefault: 'new_new' })
    expect(r).toEqual({ value: 'new_new', source: 'default', needsTranslation: false })
  })

  it('nothing set → null / default', () => {
    expect(resolveFieldValue<string>({})).toEqual({
      value: null,
      source: 'default',
      needsTranslation: false,
    })
  })

  it('empty override falls through to linked', () => {
    const r = resolveFieldValue({ override: { value: '   ' }, linked: { value: 'Linked' } })
    expect(r.source).toBe('linked')
  })

  it('empty linked falls through to master', () => {
    const r = resolveFieldValue({ linked: { value: [] as string[] }, master: ['a'] })
    expect(r.source).toBe('master')
  })
})

describe('resolveFieldValue | translate flagging', () => {
  it('cross-language TRANSLATE link → needsTranslation', () => {
    const r = resolveFieldValue({
      linked: { value: 'Giacca', translatePolicy: 'TRANSLATE', sourceLanguage: 'it' },
      targetLanguage: 'de',
    })
    expect(r.needsTranslation).toBe(true)
  })

  it('same-language link → no translation needed', () => {
    const r = resolveFieldValue({
      linked: { value: 'Giacca', translatePolicy: 'TRANSLATE', sourceLanguage: 'it' },
      targetLanguage: 'it',
    })
    expect(r.needsTranslation).toBe(false)
  })

  it('VERBATIM policy never flags translation (e.g. price)', () => {
    const r = resolveFieldValue({
      linked: { value: 189, translatePolicy: 'VERBATIM', sourceLanguage: 'it' },
      targetLanguage: 'de',
    })
    expect(r.needsTranslation).toBe(false)
  })

  it('missing source language → cannot determine, no flag', () => {
    const r = resolveFieldValue({
      linked: { value: 'x', translatePolicy: 'TRANSLATE' },
      targetLanguage: 'de',
    })
    expect(r.needsTranslation).toBe(false)
  })
})

describe('isEmptyValue', () => {
  it('null/undefined/blank/[] are empty', () => {
    expect(isEmptyValue(null)).toBe(true)
    expect(isEmptyValue(undefined)).toBe(true)
    expect(isEmptyValue('   ')).toBe(true)
    expect(isEmptyValue([])).toBe(true)
  })
  it('0 and false are NOT empty (real values)', () => {
    expect(isEmptyValue(0)).toBe(false)
    expect(isEmptyValue(false)).toBe(false)
  })
})

describe('parentageFromTags', () => {
  it('child-only → CHILD (price/qty)', () => {
    expect(parentageFromTags(['VARIATION_CHILD', 'STANDALONE'])).toBe('CHILD')
  })
  it('parent-applicable → PARENT (title/bullets)', () => {
    expect(parentageFromTags(['VARIATION_PARENT'])).toBe('PARENT')
  })
  it('both parent + child → PARENT (variants inherit)', () => {
    expect(parentageFromTags(['VARIATION_PARENT', 'VARIATION_CHILD'])).toBe('PARENT')
  })
  it('standalone-only → PARENT', () => {
    expect(parentageFromTags(['STANDALONE'])).toBe('PARENT')
  })
  it('untagged / empty → PARENT (safe inherit default)', () => {
    expect(parentageFromTags(undefined)).toBe('PARENT')
    expect(parentageFromTags([])).toBe('PARENT')
  })
})

describe('parentageFromEbayAspect', () => {
  it('variant-defining aspect → CHILD; others → PARENT', () => {
    expect(parentageFromEbayAspect(true)).toBe('CHILD')
    expect(parentageFromEbayAspect(false)).toBe('PARENT')
  })
})
