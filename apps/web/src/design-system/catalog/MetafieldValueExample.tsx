'use client'

import { MetafieldValue } from '../grid/renderers/MetafieldValue'

/*
 * 2026-09-24 — `MetafieldValue`: one stored value per Shopify metafield type, drawn by its type alone. Sample data only.
 * The picture is an inline SVG data URL so the catalog never fetches a store's files.
 */
const PICTURE = `data:image/svg+xml;utf8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><rect width="48" height="48" fill="#dbe4f0"/><circle cx="17" cy="18" r="6" fill="#8aa1c1"/><path d="M6 42l14-16 10 11 6-6 10 11z" fill="#6d839f"/></svg>')}`
const FILE = 'gid://shopify/MediaImage/1', FILE_2 = 'gid://shopify/MediaImage/2', ENTRY = 'gid://shopify/Metaobject/7', ENTRY_2 = 'gid://shopify/Metaobject/8', PRODUCT = 'gid://shopify/Product/3'
const LABELS = { [FILE]: 'size-chart.png', [FILE_2]: 'detail.jpg', [ENTRY]: 'Waterproof shell', [ENTRY_2]: 'CE level 2 armour', [PRODUCT]: 'GALE gloves' }
const IMAGES = { [FILE]: PICTURE, [FILE_2]: PICTURE, [PRODUCT]: PICTURE }

const SAMPLES: Array<{ type: string; raw: string | null; note: string }> = [
  { type: 'single_line_text_field', raw: 'Racing fit', note: 'text' },
  { type: 'multi_line_text_field', raw: 'First line\nSecond line', note: 'first line; the editor shows all' },
  { type: 'number_integer', raw: '42', note: 'number' },
  { type: 'boolean', raw: 'true', note: 'a mark and a word' },
  { type: 'boolean', raw: 'false', note: '' },
  { type: 'color', raw: '#1f6fde', note: 'a swatch of the stored colour' },
  { type: 'list.color', raw: '["#111111","#e2b33c","#c43b2f"]', note: '' },
  { type: 'rating', raw: '{"value":"4.5","scale_min":"1","scale_max":"5"}', note: 'stars and the number' },
  { type: 'money', raw: '{"amount":"149.90","currency_code":"EUR"}', note: '' },
  { type: 'weight', raw: '{"value":1.2,"unit":"KILOGRAMS"}', note: '' },
  { type: 'list.single_line_text_field', raw: '["Waterproof","Breathable","Vented"]', note: 'chips + count' },
  { type: 'file_reference', raw: FILE, note: 'the picture itself' },
  { type: 'list.file_reference', raw: JSON.stringify([FILE, FILE_2]), note: '' },
  { type: 'list.product_reference', raw: JSON.stringify([PRODUCT]), note: 'product picture and name' },
  { type: 'metaobject_reference', raw: ENTRY, note: 'the entry name' },
  { type: 'list.metaobject_reference', raw: JSON.stringify([ENTRY, ENTRY_2, 'gid://shopify/Metaobject/9']), note: 'unresolved names read "Entry", never an ID' },
  { type: 'json', raw: '{"a":1,"b":2}', note: '' },
  { type: 'list.metaobject_reference', raw: '[1,', note: 'a value that does not parse' },
  { type: 'single_line_text_field', raw: null, note: 'empty' },
]

export function MetafieldValueExample() {
  return <section id="metafield-value-example">
    <h3>MetafieldValue</h3>
    <p>A store field drawn by its type, so any store&apos;s fields look like what they are: a file as a picture, a colour as a swatch, a yes/no as a mark, a rating as stars, references as their names.</p>
    <div role="list" style={{ display: 'grid', gridTemplateColumns: 'minmax(180px, 240px) minmax(200px, 280px) 1fr', gap: 'var(--nds-space-4) var(--nds-space-12)', alignItems: 'center', fontSize: 'var(--nds-font-size-base)' }}>
      {SAMPLES.map((s, i) => <div role="listitem" key={i} style={{ display: 'contents' }}>
        <code>{s.type}</code>
        <span style={{ display: 'inline-flex', minWidth: 0, height: 28, alignItems: 'center', padding: '0 var(--nds-space-6)', border: '1px solid var(--nds-border-subtle)', borderRadius: 'var(--nds-radius-sm)', background: 'var(--nds-surface)' }}>
          <MetafieldValue type={s.type} raw={s.raw} labels={LABELS} images={IMAGES} />
        </span>
        <span style={{ color: 'var(--nds-text-muted)' }}>{s.note}</span>
      </div>)}
    </div>
  </section>
}
