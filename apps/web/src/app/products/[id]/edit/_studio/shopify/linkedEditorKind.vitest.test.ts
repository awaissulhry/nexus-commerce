import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { SHOPIFY_TYPE_CATALOG } from '@nexus/shared/shopify-type-catalog'
import { LAB_ENTRIES, LAB_SCHEMA, LAB_STORE_FIELDS, LAB_STORE_START, labGoodValue, labTypeField } from '@nexus/shared/shopify-lab-store'
import { linkedEditorKind, dateTimeRepairing } from './linkedEditorKind'
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
      temperature: 'compound', 'list.temperature': 'list', multi_line_text_field: 'multi-line', json: 'json', jurisdiction: 'code', language: 'code', id: 'line',
      rich_text_field: 'rich-text', date: 'date', date_time: 'date-time', mixed_reference: 'entries',
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

/* ── Slice B3b (PLAN §6.3): dates, JSON, codes, link, money, rich text. ── */
import { renderToStaticMarkup as html } from 'react-dom/server'
import { ShopifyRichText } from '../images/shopify/ShopifyFieldValue'

describe('B3b · the editor each type opens', () => {
  it('date and time: the picker for a moment or nothing; a repair box for what cannot be read (G15)', () => {
    const def = labTypeField('date_time')
    for (const value of [null, '', '2026-09-28T12:30:00', '2026-09-28T12:30:00+02:00', '2031-01-01T00:00:00']) expect(linkedEditorKind(def, value, LAB_SCHEMA), String(value)).toBe('date-time')
    for (const value of ['Sep 28 2026 12:30', '2026-02-30T12:00:00', 'tomorrow']) expect(linkedEditorKind(def, value, LAB_SCHEMA), value).toBe('line')
    expect(linkedEditorKind(labTypeField('list.date_time'), '["2026-09-28T12:30:00"]', LAB_SCHEMA)).toBe('list')
  })
  it('JSON gets the checked JSON box; language and jurisdiction a code line; id stays a plain line (G16)', () => {
    expect(linkedEditorKind(labTypeField('json'), '{"fit":', LAB_SCHEMA)).toBe('json')
    expect(linkedEditorKind(labTypeField('jurisdiction'), 'Italy', LAB_SCHEMA)).toBe('code')
    expect(linkedEditorKind(labTypeField('language'), null, LAB_SCHEMA)).toBe('code')
    expect(linkedEditorKind(labTypeField('id'), 'LAB-1', LAB_SCHEMA)).toBe('line')
    expect(linkedEditorKind(labTypeField('link'), null, LAB_SCHEMA)).toBe('compound')
    expect(linkedEditorKind(labTypeField('money'), null, LAB_SCHEMA)).toBe('compound')
  })
})

describe('B3b · what the editors show', () => {
  it('date and time: the design-system picker in the viewer’s zone, the UTC moment in words, no text box (G15)', () => {
    const out = render(labTypeField('date_time'), '2026-09-28T12:30:00')
    expect(out).toContain('nds-datetimefield')
    expect(out).toContain('That is 2026-09-28 12:30 (UTC).')
    expect(out).toContain('nds-datetimefield-zone')
    /* The picker shows the viewer's own day (12:30 UTC is 29 September from UTC+12): expect that day, in any zone. */
    const at = new Date('2026-09-28T12:30:00Z'), localDay = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`
    expect(out).toContain(`>${localDay}<`)
    expect(out).toContain('From 2020-01-01 00:00 (UTC) to 2030-12-31 23:59:59 (UTC)')
    expect(out).not.toContain('<input')
    const zoned = render(labTypeField('date_time'), '2026-09-28T14:30:00+02:00')
    expect(zoned).toContain('That is 2026-09-28 12:30 (UTC).')
    const empty = render(labTypeField('date_time'), null)
    expect(empty).toContain('Choose a date'); expect(empty).not.toContain('That is')
  })
  it('date and time that cannot be read: a repair box that says how to write it, and why it is refused (G15)', () => {
    const out = render(labTypeField('date_time'), 'Sep 28 2026 12:30')
    expect(out).toContain('>Repair Date time<')
    expect(out).toContain('value="Sep 28 2026 12:30"')
    expect(out).toContain('Type it as 2026-09-28T12:30:00 (UTC), or clear the value to use the date picker.')
    expect(out).toContain('Choose a date and a time.')
    expect(out).not.toContain('nds-datetimefield')
  })
  it('JSON: a box with the key line, and the error line names the place of the mistake (G16)', () => {
    const out = render(labTypeField('json'), '{"fit":"regular"}}')
    expect(out).toContain('<textarea')
    expect(out).toContain('Enter adds a line · Ctrl+Enter (⌘+Enter on a Mac) saves')
    expect(out).toContain('This is not valid JSON: there is more text after the end, at line 1, character 18.')
    expect(out).not.toContain('Structured Shopify value')
    expect(render(labTypeField('json'), '{"size":"M"}')).toContain('The store’s JSON schema requires this value must have required property &#x27;fit&#x27;.')
  })
  it('codes: one line with an example, not the structured box (G16)', () => {
    const jurisdiction = render(labTypeField('jurisdiction'), 'IT')
    expect(jurisdiction).toContain('For example IT, or US-CA for a region.'); expect(jurisdiction).toMatch(/<input[^>]*value="IT"/); expect(jurisdiction).not.toContain('<textarea')
    expect(jurisdiction).toContain('autoCapitalize="characters"')
    const language = render(labTypeField('language'), 'english')
    expect(language).toContain('For example en or it-IT.'); expect(language).toContain('Enter a language code, for example en or it-IT.')
    expect(language).toContain('autoCapitalize="off"')
  })
  it('link: text and address, the allowed sites on the rule line, a link elsewhere refused in the same words as a url (G17)', () => {
    const out = render(labTypeField('link'), '{"text":"Elsewhere","url":"https://other.test/"}')
    expect(out).toContain('Link text'); expect(out).toContain('Only links on example.com')
    expect(out).toContain('Use a link on one of these sites: example.com.')
  })
  it('money: the store’s currency is fixed text beside the amount, not an input', () => {
    const out = render(labTypeField('money'), '{"amount":"149.90","currency_code":"EUR"}')
    expect(out).toMatch(/<input[^>]*value="149.90"/)
    expect(out).toContain('<span class="ad suf">EUR</span>')
    expect(out).toContain('aria-label="Amount in EUR"')
    expect(out).not.toContain('>Currency<')
    expect(out).not.toContain('value="EUR"')
    const empty = render(labTypeField('money'), null)
    expect(empty).toContain('<span class="ad suf">EUR</span>')
  })
  it('money in another currency: that currency is shown, with one sentence about it', () => {
    const out = render(labTypeField('money'), '{"amount":"20.00","currency_code":"USD"}')
    expect(out).toContain('<span class="ad suf">USD</span>')
    expect(out).toContain('This amount is in USD, but the store uses EUR: enter the amount in EUR.')
    expect(render(labTypeField('money'), '{"amount":"20.00","currency_code":"EUR"}')).not.toContain('but the store uses')
  })
  it('rich text: the words to edit, and a repair box for a broken tree with the reason under it', () => {
    const good = render(labTypeField('rich_text_field'), labGoodValue('rich_text_field'))
    expect(good).toContain('Made-up '); expect(good).toContain('Bold'); expect(good).toContain('Add paragraph'); expect(good).not.toContain('Repair rich text JSON')
    const broken = render(labTypeField('rich_text_field'), '{"type":"root"')
    expect(broken).toContain('aria-label="Repair rich text JSON"'); expect(broken).not.toContain('Add paragraph')
    expect(broken).toContain('This is not valid JSON: the text ends where “,” or “}” is needed.')
    const wrong = render(labTypeField('rich_text_field'), '{"type":"paragraph"}')
    expect(wrong).toContain('aria-label="Repair rich text JSON"'); expect(wrong).toContain('Use rich text with a root and children.')
    expect(html(createElement(ShopifyRichText, { raw: '', disabled: false, onChange: () => {} }))).toContain('Text 1')
  })
})

/* B3 review: the date-time repair box follows the value typed in it, never a list position. */
describe('B3 review · the date-time repair box', () => {
  it('opens for a value that cannot be read, stays for the text typed in it, and never for another readable value', () => {
    expect(dateTimeRepairing('line', 'date_time', 'Sep 28 2026 12:30', null)).toBe(true)
    expect(dateTimeRepairing('date-time', 'date_time', '2026-09-28T12:30', '2026-09-28T12:30')).toBe(true)
    /* A list lost its first (broken) value: the readable value now in that place gets the picker. */
    expect(dateTimeRepairing('date-time', 'date_time', '2026-10-01T09:00:00', 'Sep 28 2026 12:30')).toBe(false)
    expect(dateTimeRepairing('date-time', 'date_time', '', 'x')).toBe(false)
    expect(dateTimeRepairing('date-time', 'date_time', null, null)).toBe(false)
    expect(dateTimeRepairing('line', 'single_line_text_field', 'x', 'x')).toBe(false)
  })
})
