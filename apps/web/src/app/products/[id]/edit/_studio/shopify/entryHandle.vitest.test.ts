import { describe, expect, it } from 'vitest'
import { labKind } from '@nexus/shared/shopify-lab-store'
import { ENTRY_HANDLE, entryDisplayKey, entryHandle } from './entryHandle'

/* Lane B slice B2: readable, stable handles for new entries — never `nexus-<uuid>` again. */
describe('entry handles', () => {
  it('are made from the display field, readable, and always valid for Shopify', () => {
    for (const [display, handle] of [['Water-repellent', 'water-repellent-k2p9'], ['Größe & Passform!', 'grosse-passform-k2p9'], ['', 'entry-k2p9'], [null, 'entry-k2p9'], ['   ', 'entry-k2p9'], ['x'.repeat(80), `${'x'.repeat(40)}-k2p9`]] as const) {
      expect(entryHandle(display, 'k2p9')).toBe(handle)
      expect(entryHandle(display, 'k2p9')).toMatch(ENTRY_HANDLE)
    }
  })
  it('find the field an entry is known by', () => {
    expect(entryDisplayKey(labKind('shopify--color-pattern'))).toBe('label')
    expect(entryDisplayKey(labKind('lab_icon_text'))).toBe('heading')
    expect(entryDisplayKey(labKind('lab_faq'))).toBe('question')
    expect(entryDisplayKey(labKind('lab_summary'))).toBeUndefined()
  })
})
