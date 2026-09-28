import { describe, expect, it } from 'vitest'
import { labKind } from '@nexus/shared/shopify-lab-store'
import { ENTRY_HANDLE, entryDisplayKey, entryHandle, entrySaveProblems } from './entryHandle'

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

/* B2 review finding (2026-09-28): the check before an entry save is the server's check — on what the save sends. */
describe('what stops an entry save', () => {
  const colour = labKind('shopify--color-pattern').fields
  const stored: Record<string, string | null> = { label: 'Moss', color: 'not a colour', image: null, color_taxonomy_reference: null, pattern_taxonomy_reference: 'gid://shopify/TaxonomyValue/9101' }
  const keys = (typed: Record<string, string | null>, sent: (key: string) => boolean) =>
    entrySaveProblems(colour, key => key in typed ? typed[key] : stored[key], sent).map(p => [p.def.key, p.problem])
  it('an old odd value in a field the user did not touch does not stop a save of another field', () => {
    expect(keys({ label: 'Moss green' }, key => key === 'label')).toEqual([['color_taxonomy_reference', 'Enter a value. Shopify needs this field.']])
  })
  it('a required field left empty stops it, like the server', () => {
    expect(keys({ label: 'Moss green', color_taxonomy_reference: '["gid://shopify/TaxonomyValue/9001"]' }, key => ['label', 'color_taxonomy_reference'].includes(key))).toEqual([])
  })
  it('a field that is sent is checked against its rules', () => {
    expect(keys({ color: 'not a colour' }, key => key === 'color').map(([key]) => key)).toEqual(['color', 'color_taxonomy_reference'])
    expect(keys({ label: '' }, key => key === 'label')[0]).toEqual(['label', 'Enter a value. Shopify needs this field.'])
  })
  it('a copy sends every field, so every field is checked', () => {
    expect(keys({}, () => true).map(([key]) => key)).toEqual(['color', 'color_taxonomy_reference'])
  })
})
