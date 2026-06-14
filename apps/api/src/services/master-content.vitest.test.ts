/**
 * A4 — MasterContentService cascade resolution. The transactional plumbing mirrors
 * the proven MasterPriceService; this locks the per-listing decision: snapshot the
 * master always, push only the fields the listing follows.
 */
import { describe, it, expect } from 'vitest'
import { resolveContentCascade } from './master-content.service.js'

const allFollow = { followMasterTitle: true, followMasterDescription: true, followMasterBulletPoints: true }

describe('resolveContentCascade', () => {
  it('following listing → snapshot + push the new value', () => {
    const { snapshot, push } = resolveContentCascade(
      { title: true, description: false, bulletPoints: false }, { title: 'New' }, allFollow,
    )
    expect(snapshot.masterTitle).toBe('New')
    expect(push.title).toBe('New')
  })

  it('overridden field → snapshot only, NO push (keeps the override)', () => {
    const { snapshot, push } = resolveContentCascade(
      { title: true, description: false, bulletPoints: false }, { title: 'New' },
      { ...allFollow, followMasterTitle: false },
    )
    expect(snapshot.masterTitle).toBe('New')
    expect(push.title).toBeUndefined()
  })

  it('only the changed field is touched', () => {
    const { snapshot, push } = resolveContentCascade(
      { title: false, description: true, bulletPoints: false }, { description: 'D' }, allFollow,
    )
    expect(snapshot.masterTitle).toBeUndefined()
    expect(snapshot.masterDescription).toBe('D')
    expect(push.description).toBe('D')
    expect(push.title).toBeUndefined()
  })

  it('bulletPoints push as an array', () => {
    const { snapshot, push } = resolveContentCascade(
      { title: false, description: false, bulletPoints: true }, { bulletPoints: ['a', 'b'] }, allFollow,
    )
    expect(snapshot.masterBulletPoints).toEqual(['a', 'b'])
    expect(push.bulletPoints).toEqual(['a', 'b'])
  })

  it('mixed: title followed (push), description overridden (snapshot-only)', () => {
    const { push } = resolveContentCascade(
      { title: true, description: true, bulletPoints: false }, { title: 'T', description: 'D' },
      { ...allFollow, followMasterDescription: false },
    )
    expect(push.title).toBe('T')
    expect(push.description).toBeUndefined()
  })
})
