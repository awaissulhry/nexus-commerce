import { describe, expect, it } from 'vitest'
import { acknowledgeGridView, type ApiView, type SavedGridView } from './useGridViews'

const payload = { v: 2 as const, kind: 'columns' as const, columns: ['brand'] }
const view = (overrides: Partial<SavedGridView<null>> = {}): SavedGridView<null> => ({ id: 'one', name: 'Brand', isDefault: false, payload, updatedAt: '2026-09-05T10:00:00.000Z', ...overrides })
const response = (overrides: Partial<ApiView> = {}): ApiView => ({ id: 'one', name: 'Brand', isDefault: false, filters: payload, updatedAt: '2026-09-05T10:00:01.000Z', legacyShared: false, ...overrides })

describe('saved-view acknowledgements before list refresh', () => {
  it('inserts a committed view even when no list response follows', () => {
    expect(acknowledgeGridView([], response())).toEqual([view({ updatedAt: response().updatedAt, legacyShared: false })])
  })

  it('replaces a shared template with the same-name personal copy', () => {
    const next = acknowledgeGridView([view({ legacyShared: true }), view({ id: 'other', name: 'Other' })], response({ id: 'personal' }))
    expect(next.map((entry) => entry.id)).toEqual(['personal', 'other'])
    expect(next[0].legacyShared).toBe(false)
  })

  it('retains the legacy template when the personal copy has a different name', () => {
    const next = acknowledgeGridView([view({ legacyShared: true })], response({ id: 'personal', name: 'My brand' }))
    expect(next.map((entry) => entry.id)).toEqual(['one', 'personal'])
  })

  it('does not regress a newer acknowledgement when earlier writes finish later', () => {
    const current = [view({ name: 'Latest', updatedAt: '2026-09-05T10:00:03.000Z' })]
    expect(acknowledgeGridView(current, response())).toBe(current)
  })

  it('keeps a newer default when an earlier default acknowledgement arrives late', () => {
    const current = [view({ id: 'new-default', name: 'Latest', isDefault: true, updatedAt: '2026-09-05T10:00:03.000Z' })]
    const next = acknowledgeGridView(current, response({ isDefault: true }))
    expect(next.filter((entry) => entry.isDefault).map((entry) => entry.id)).toEqual(['new-default'])
  })

  it('clears the preceding default when the committed default is newer', () => {
    const current = [view({ id: 'old-default', isDefault: true })]
    const next = acknowledgeGridView(current, response({ isDefault: true }))
    expect(next.filter((entry) => entry.isDefault).map((entry) => entry.id)).toEqual(['one'])
    expect(current[0].isDefault).toBe(true)
  })
})
