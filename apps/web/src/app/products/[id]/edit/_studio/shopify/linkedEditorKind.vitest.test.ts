import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { SHOPIFY_TYPE_CATALOG } from '@nexus/shared/shopify-type-catalog'
import { LAB_ENTRIES, LAB_SCHEMA, LAB_STORE_FIELDS, LAB_STORE_START, labGoodValue, labTypeField } from '@nexus/shared/shopify-lab-store'
import { linkedEditorKind } from './linkedEditorKind'
import { LinkedFieldEditor } from './LinkedFieldEditor'

/* Lane B slice B1 (docs/shopify-metafields/PLAN-2026-09-28.md §6.1, §7 L2): which editor each type opens, and what the
   B1 editors show. Made-up store; rendered in Node (`renderToStaticMarkup`) — interaction is the lab's browser test. */
const store = (key: string) => LAB_STORE_FIELDS.find(field => field.key === key)!
const render = (def: Parameters<typeof LinkedFieldEditor>[0]['definition'], value: string | null) =>
  renderToStaticMarkup(createElement(LinkedFieldEditor, { path: '/fixture?accountId=lab', definition: def, value, disabled: false, schema: LAB_SCHEMA, onChange: () => {} }))

describe('B1 · the editor each store type opens', () => {
  it.each([
    ['related_items_display', 'choices'], ['variation_label', 'line'], ['search_words', 'list'], ['icons_with_text', 'entries'],
    ['short_summary', 'entries'], ['colour_category', 'entries'], ['related_items', 'resources'], ['average_rating', 'rating'],
    ['rating_count', 'line'], ['feed_custom_product', 'yes-no'], ['size_guide_page', 'resources'], ['swatch_picture', 'resources'],
    ['swatch_colour', 'colour'], ['sort_position', 'line'],
  ])('%s → %s', (key, kind) => {
    expect(linkedEditorKind(store(key), LAB_STORE_START[store(key).id] ?? null, LAB_SCHEMA)).toBe(kind)
  })
  it('gives every Shopify type an editor and never throws (118 types)', () => {
    const kinds = Object.fromEntries(SHOPIFY_TYPE_CATALOG.map(({ name }) => [name, linkedEditorKind(labTypeField(name), labGoodValue(name), LAB_SCHEMA)]))
    expect(kinds).toMatchObject({
      temperature: 'compound', 'list.temperature': 'list', multi_line_text_field: 'multi-line', json: 'box', jurisdiction: 'box',
      rich_text_field: 'rich-text', date: 'date', date_time: 'line', mixed_reference: 'older-picker',
      /* No category on this made-up field, so Shopify cannot list its values: the older picker keeps it settable (B2 review). */
      product_taxonomy_value_reference: 'older-picker',
      'list.variant_reference': 'resources', metaobject_reference: 'entries', rating: 'rating', money: 'compound', link: 'compound',
    })
    for (const { name } of SHOPIFY_TYPE_CATALOG) expect(() => render(labTypeField(name), labGoodValue(name)), name).not.toThrow()
  })
  it('repairs what does not parse, and a date that is not valid is typed as text', () => {
    expect(linkedEditorKind(labTypeField('list.weight'), '[1,', LAB_SCHEMA)).toBe('broken-list')
    expect(linkedEditorKind(store('icons_with_text'), '[1,', LAB_SCHEMA)).toBe('box')
    const one = LAB_ENTRIES.find(e => e.type === 'lab_icon_text')!.id
    expect(linkedEditorKind(store('icons_with_text'), JSON.stringify([one, one]), LAB_SCHEMA)).toBe('box')
    expect(linkedEditorKind(labTypeField('date'), '2026-13-40', LAB_SCHEMA)).toBe('line')
  })
})

describe('B1 · what the editors show', () => {
  it('rating: the store’s scale as a fact, a stepper for the value, the stars — no typed scale (G2)', () => {
    const html = render(store('average_rating'), '{"value":"4.5","scale_min":"1.0","scale_max":"5.0"}')
    expect(html).toContain('Scale 1 to 5, set by the store.')
    expect(html).toContain('nds-nstep')
    expect(html).toContain('aria-label="Rating 4.5 / 5"')
    expect(html).not.toContain('Scale minimum')
    expect(render(store('average_rating'), '{"value":"8","scale_min":"0","scale_max":"10"}')).toContain('This value uses another scale (0 to 10)')
  })
  it('yes/no: the same words as the cell (G3)', () => {
    const html = render(store('feed_custom_product'), 'true')
    expect(html).toContain('>Yes</option>'); expect(html).toContain('>No</option>'); expect(html).not.toContain('>True<')
  })
  it('a list at its limit: "Add value" is disabled and says why (G4)', () => {
    const full = render(store('search_words'), JSON.stringify(Array.from({ length: 10 }, (_, i) => `w${i}`)))
    expect(full).toMatch(/<button[^>]*disabled=""[^>]*aria-describedby="[^"]+-list-full"[^>]*>Add value<\/button>/)
    expect(full).toContain('The store takes 10 values at most. Remove one to add another.')
    const room = render(store('search_words'), '["a"]')
    expect(room).not.toContain('at most. Remove one')
  })
  it('the rules in plain words, once, instead of the raw rule table (G6)', () => {
    const html = render(store('search_words'), '["a"]')
    expect(html).toContain('Up to 100 characters each · Up to 10 values')
    expect(html.match(/Up to 100 characters/g)).toHaveLength(1)
    expect(html).not.toContain('Store validation rules')
    expect(render(store('related_items'), '[]')).toContain('Up to 10 products')
    expect(html.match(/>Clear value</g)).toHaveLength(1)
    expect(html.match(/>Remove value</g)).toHaveLength(1)
  })
  it('multi-line: its own key fact on its help line (G5)', () => {
    expect(render(labTypeField('multi_line_text_field'), 'One\nTwo')).toContain('Enter adds a line · Ctrl+Enter (⌘+Enter on a Mac) saves')
  })
})
