import { describe, expect, it } from 'vitest'
import { primaryStudioAccount, studioAccountAccess } from './accountScope'

const a = { id: 'a', label: 'Store A', primary: false }
const b = { id: 'b', label: 'Store B', primary: false }
describe('Studio account selection and primary-only tools', () => {
  it('supports a single account even without its primary flag', () => {
    expect(primaryStudioAccount([a])).toBe(a)
    expect(studioAccountAccess([a], 'a').supportsPrimaryTools).toBe(true)
  })
  it('never picks the first of several accounts or several claimed primaries', () => {
    expect(primaryStudioAccount([a, b])).toBeUndefined()
    expect(primaryStudioAccount([{ ...a, primary: true }, { ...b, primary: true }])).toBeUndefined()
    expect(studioAccountAccess([a, b], 'b')).toMatchObject({ selected: b, supportsPrimaryTools: false })
  })
  it('keeps alternate, missing and disconnected accounts out of primary-only tools', () => {
    const accounts = [{ ...a, primary: true }, b]
    for (const id of ['b', 'disconnected', undefined]) expect(studioAccountAccess(accounts, id).supportsPrimaryTools).toBe(false)
    expect(studioAccountAccess(accounts, 'disconnected').selected).toBeUndefined()
    expect(studioAccountAccess(accounts, 'a').supportsPrimaryTools).toBe(true)
  })
})
