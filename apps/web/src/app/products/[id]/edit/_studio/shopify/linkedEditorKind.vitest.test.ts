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
      rich_text_field: 'rich-text', date: 'date', date_time: 'line', mixed_reference: 'entries',
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

/* ── Lane B slice B3c (PLAN §6.3, gap G18): mixed and disclosure fields open the tick list, with a kind switch when the
   field takes several kinds; every other reference type's editor pinned. ── */
import type { ShopifyFieldDefinition } from '@nexus/shared/shopify-linked-products'
import { labKind } from '@nexus/shared/shopify-lab-store'

const renderWith = (def: ShopifyFieldDefinition, value: string | null, schema = LAB_SCHEMA) =>
  renderToStaticMarkup(createElement(LinkedFieldEditor, { path: '/fixture?accountId=lab', definition: def, value, disabled: false, schema, onChange: () => {}, onCreateEntry: () => {} }))
const withRules = (type: string, validations: Array<{ name: string; value: string }>): ShopifyFieldDefinition => ({ ...labTypeField(type), validations })

describe('B3c · the editor every reference type opens', () => {
  /* The two taxonomy-value types are pinned by slice B2 (their rule is B2's). */
  it('pins all 25 other reference types, with their good value', () => {
    const refs = SHOPIFY_TYPE_CATALOG.map(t => t.name).filter(name => name.endsWith('_reference') && !name.includes('taxonomy_value'))
    expect(Object.fromEntries(refs.map(name => [name, linkedEditorKind(labTypeField(name), labGoodValue(name), LAB_SCHEMA)]))).toEqual({
      product_taxonomy_disclosure_reference: 'older-picker',
      metaobject_reference: 'entries', 'list.metaobject_reference': 'entries', mixed_reference: 'entries', 'list.mixed_reference': 'entries',
      disclosure_reference: 'entries', 'list.disclosure_reference': 'entries',
      product_reference: 'resources', 'list.product_reference': 'resources', variant_reference: 'resources', 'list.variant_reference': 'resources',
      collection_reference: 'resources', 'list.collection_reference': 'resources', page_reference: 'resources', 'list.page_reference': 'resources',
      article_reference: 'resources', 'list.article_reference': 'resources', file_reference: 'resources', 'list.file_reference': 'resources',
      customer_reference: 'resources', 'list.customer_reference': 'resources', company_reference: 'resources', 'list.company_reference': 'resources',
      order_reference: 'resources', 'list.order_reference': 'resources',
    })
  })
  it('an empty value opens the same editor; a list that does not parse, or holds one entry twice, opens the repair box', () => {
    for (const type of ['mixed_reference', 'list.mixed_reference', 'disclosure_reference', 'list.disclosure_reference', 'list.variant_reference', 'order_reference']) {
      expect(linkedEditorKind(labTypeField(type), null, LAB_SCHEMA), type).toBe(type.includes('mixed') || type.includes('disclosure') ? 'entries' : 'resources')
    }
    const faq = LAB_ENTRIES.find(e => e.type === 'lab_faq')!.id
    expect(linkedEditorKind(labTypeField('list.mixed_reference'), '[1,', LAB_SCHEMA)).toBe('box')
    expect(linkedEditorKind(labTypeField('list.mixed_reference'), JSON.stringify([faq, faq]), LAB_SCHEMA)).toBe('box')
  })
  it('a mixed field whose kinds are not known keeps the older picker', () => {
    expect(linkedEditorKind(withRules('list.mixed_reference', []), null, LAB_SCHEMA)).toBe('older-picker')
  })
})

describe('B3c · what the mixed and disclosure editors show', () => {
  it('a list of mixed: the kind switch (only the allowed kinds, the first chosen), the list of that kind, "Add new FAQ entry"', () => {
    const html = renderWith(labTypeField('list.mixed_reference'), labGoodValue('list.mixed_reference'))
    expect(html).toMatch(/role="radiogroup" aria-label="Entry kind"/)
    expect(html.match(/role="radio"/g)).toHaveLength(2)
    expect(html).toMatch(/role="radio" aria-checked="true"[^>]*>FAQ<\/button>/)
    expect(html).toMatch(/role="radio" aria-checked="false"[^>]*>Press quote<\/button>/)
    expect(html).toContain('aria-label="FAQ entries"')
    expect(html).toContain('> Add new FAQ entry</button>')
    expect(html).toContain('aria-label="Chosen List of mixed reference"')
    expect(html).toContain('FAQ or Press quote entries · Up to 5 entries')
    /* Before the first page: "Loading…", never "This store has no FAQ yet". */
    expect(html).toContain('Loading…')
    expect(html).not.toContain('This store has no')
    expect(html).not.toContain('Reusable entry type')
    expect(html).not.toContain('Choose reference')
  })
  it('one mixed entry: an empty field opens the switch and a search line; a set one shows its card', () => {
    const empty = renderWith(labTypeField('mixed_reference'), null)
    expect(empty).toMatch(/role="radiogroup" aria-label="Entry kind"/)
    expect(empty).toContain('aria-label="Search FAQ"')
    const set = renderWith(labTypeField('mixed_reference'), labGoodValue('mixed_reference'))
    expect(set).not.toContain('role="radiogroup"')
    expect(set).toContain('>Change</button>')
  })
  it('a disclosure field takes one kind here: no switch, plain "Add new entry"', () => {
    for (const type of ['disclosure_reference', 'list.disclosure_reference']) {
      const html = renderWith(labTypeField(type), null)
      expect(html, type).not.toContain('role="radiogroup"')
      expect(html, type).toContain('aria-label="Disclosure (made up) entries"')
      expect(html, type).toContain('> Add new entry</button>')
      expect(html, type).toContain('Disclosure (made up) entries')
    }
  })
  it('five kinds: a select labelled "Entry kind" with the five, in the definition’s order', () => {
    const five = ['lab_faq', 'lab_press', 'lab_heading', 'lab_button', 'lab_ticker']
    const html = renderWith(withRules('list.mixed_reference', [{ name: 'metaobject_definition_types', value: JSON.stringify(five) }]), null)
    expect(html).not.toContain('role="radiogroup"')
    expect(html).toMatch(/<label[^>]*>Entry kind<\/label>/)
    expect([...html.matchAll(/<option value="([^"]+)"/g)].map(m => m[1])).toEqual(five)
    expect(five.map(type => labKind(type).name)).toEqual(['FAQ', 'Press quote', 'Heading', 'Button', 'Ticker text'])
  })
  it('kinds not known: the older picker with its reason; kinds gone: its button is disabled and says why', () => {
    const unknown = renderWith(withRules('list.mixed_reference', []), null)
    expect(unknown).toContain('This field does not name its entry kinds. Choose a kind first, then an entry.')
    expect(unknown).toMatch(/<button(?![^>]*disabled)[^>]*aria-describedby="[^"]+-picker-reason"[^>]*>Choose reference<\/button>/)
    const gone = renderWith(withRules('list.mixed_reference', [{ name: 'metaobject_definition_types', value: '["gone_kind"]' }]), null)
    expect(gone).toContain('This field’s entry kinds are no longer in the store. Refresh the store schema.')
    expect(gone).toMatch(/<button[^>]*disabled=""[^>]*aria-describedby="([^"]+)-picker-reason"[^>]*>Choose reference<\/button>/)
    const id = /aria-describedby="([^"]+-picker-reason)"/.exec(gone)![1]
    expect(gone).toContain(`id="${id}"`)
  })
})
