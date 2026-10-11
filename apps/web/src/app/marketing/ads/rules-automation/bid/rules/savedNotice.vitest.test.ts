import { describe, expect, it } from 'vitest'
import { followNotice, noticeWords, savedNotice } from './savedNotice'

describe('the detail after a builder save', () => {
  it('a new rule: "Rule created" with Undo, in the Negative Targeting page’s words', () => {
    expect(noticeWords(savedNotice('r9', 'created'))).toEqual({ tone: 'success', title: 'Rule created', body: 'Undo archives it again.', undo: true })
  })

  it('a refused Undo stays in the detail with the server’s words', () => {
    const n = { ...savedNotice('r9', 'created'), error: 'Rule not found' }
    expect(noticeWords(n)).toEqual({ tone: 'warning', title: 'Rule created', body: 'Not undone: Rule not found', undo: true })
  })

  it('a saved edit: "Saved", no Undo', () => {
    expect(noticeWords(savedNotice('r9', 'updated'))).toEqual({ tone: 'success', title: 'Saved', body: null, undo: false })
  })

  it('waits while the builder leaves, holds on its rule, ends when the detail leaves it', () => {
    const n = savedNotice('r9', 'created')
    // The builder is still going: no rule open yet (or the old address).
    expect(followNotice(n, false, null)).toEqual({ keep: true, seen: false })
    expect(followNotice(n, false, 'r1')).toEqual({ keep: true, seen: false })
    // The detail opened on it.
    expect(followNotice(n, false, 'r9')).toEqual({ keep: true, seen: true })
    expect(followNotice(n, true, 'r9')).toEqual({ keep: true, seen: true })
    // Closed, Back, Prev / Next or Edit all.
    expect(followNotice(n, true, null)).toEqual({ keep: false, seen: true })
    expect(followNotice(n, true, 'r1')).toEqual({ keep: false, seen: true })
  })

  it('no notice: nothing kept, nothing seen', () => {
    expect(followNotice(null, true, 'r9')).toEqual({ keep: false, seen: false })
  })
})
