import { describe, expect, it } from 'vitest'
import { hasHint, keyValueRootProps } from './key-value'

describe('keyValueRootProps — the <dl> root', () => {
  it('defaults to one column and the bare class', () => {
    expect(keyValueRootProps({})).toEqual({ className: 'nds-kv', 'data-columns': 1 })
  })

  it('carries 2 and 3 columns as data-columns', () => {
    expect(keyValueRootProps({ columns: 2 })['data-columns']).toBe(2)
    expect(keyValueRootProps({ columns: 3 })['data-columns']).toBe(3)
  })

  it('adds dense and the caller class, in that order', () => {
    expect(keyValueRootProps({ dense: true }).className).toBe('nds-kv dense')
    expect(keyValueRootProps({ className: 'x' }).className).toBe('nds-kv x')
    expect(keyValueRootProps({ dense: true, className: 'x' }).className).toBe('nds-kv dense x')
  })
})

describe('hasHint — when the dd gets a sub-line', () => {
  it('renders for anything React would print', () => {
    expect(hasHint('access token')).toBe(true)
    expect(hasHint(0)).toBe(true)
    expect(hasHint('')).toBe(true)
  })
  it('is absent for null, undefined and false', () => {
    expect(hasHint(null)).toBe(false)
    expect(hasHint(undefined)).toBe(false)
    expect(hasHint(false)).toBe(false)
  })
})
