'use client'

/**
 * Catalog: the media pickers (sheet pop-up rebuild P0, docs/sheet-popup-editor/PLAN-2026-09-27.md §4.1).
 *
 * Every value below is MADE UP — invented names, `example/…` ids and drawn SVG pictures. The repository is public, so
 * no real store id, handle or product may appear here.
 */
import { useMemo, useRef, useState } from 'react'

import { Button } from '../primitives/Button'
import { MediaChipField } from '../components/MediaChipField'
import { MediaOrderedList } from '../components/MediaOrderedList'
import { MediaPickList, type MediaPickListHandle } from '../components/MediaPickList'
import { ResourcePickerDialog } from '../components/ResourcePickerDialog'
import { resolveChosen, toggleChoice, type MediaChoice } from '../lib/media-choice'

/** A drawn picture: a jacket outline with `n` stripes, in the given ink. */
const drawn = (label: string, ink = 'black') => {
  const n = [...label].reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % 3 + 1
  const stripes = Array.from({ length: n }, (_, i) => `<rect x="70" y="${90 + i * 40}" width="60" height="14" rx="7" fill="${ink}"/>`).join('')
  return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200" fill="white"/><path d="M60 40 L140 40 L170 80 L150 90 L150 170 L50 170 L50 90 L30 80 Z" fill="none" stroke="${ink}" stroke-width="6"/>${stripes}</svg>`)}`
}

const COLOURS: MediaChoice[] = [
  { value: 'example/colour/green', label: 'Green', swatch: '#3c9a4b', group: 'This store' },
  { value: 'example/colour/black', label: 'Black', swatch: '#111111', group: 'This store' },
  { value: 'example/colour/beige', label: 'Beige', swatch: '#e6d8b0', group: 'Default entries' },
  { value: 'example/colour/blue', label: 'Blue', swatch: '#2458d6', group: 'Default entries' },
  { value: 'example/colour/clear', label: 'Clear', swatch: '#ffffff', group: 'Default entries' },
  { value: 'example/colour/gold', label: 'Gold', swatch: '#caa03a', group: 'Default entries', heldReason: 'Not offered in this category' },
  { value: 'example/colour/navy', label: 'Navy', swatch: '#232a8f', group: 'Default entries' },
]

const ICONS: MediaChoice[] = ['Water-repellent', 'Regular fit', 'Air vents', 'Tough fabric'].map(label => ({
  value: `example/icon/${label.toLowerCase().replace(/\W+/g, '-')}`, label, image: drawn(label), detail: 'Text with icon',
}))

const PRODUCTS: MediaChoice[] = ['Sample Jacket', 'Sample Jacket · Grey', 'Sample Pant', 'Sample Vest', 'Sample Gloves', 'Sample Boots'].map((label, i) => ({
  value: `example/product/${i + 1}`, label, detail: `SAMPLE-${100 + i}`, image: drawn(label, i % 2 ? 'dimgray' : 'black'),
}))

export function MediaPickersExample() {
  const [colours, setColours] = useState<string[]>(['example/colour/black', 'example/gone/7'])
  const [colourQuery, setColourQuery] = useState('')
  const [extra, setExtra] = useState<MediaChoice[]>([])
  const allColours = useMemo(() => [...COLOURS, ...extra], [extra])
  /* The chip line keeps focus while ↑ ↓ Space move through the list below — the list takes the keys through its handle. */
  const colourList = useRef<MediaPickListHandle>(null)
  const [colourActive, setColourActive] = useState<string>()

  const [icon, setIcon] = useState<string[]>([ICONS[1].value])
  const [products, setProducts] = useState<string[]>([PRODUCTS[0].value, PRODUCTS[1].value])
  const [pickerOpen, setPickerOpen] = useState(false)
  const [productQuery, setProductQuery] = useState('')

  return (
    <section id="media-pickers-example">
      <h3>Media pickers</h3>
      <p>Choices that carry a picture or a colour swatch — metaobject entries, products, files, variation values. The
        mark is a picture, else a swatch, else nothing: no empty picture boxes. A value that no longer exists stays
        visible, marked, until it is removed. All data here is made up.</p>

      <h4>List of entries: chips over a pick list (with groups, a held entry and “Add new entry”)</h4>
      <div style={{ maxWidth: 480, display: 'grid', gap: 8 }}>
        <MediaChipField label="Chosen colours" items={resolveChosen(colours, allColours)} onChange={setColours}
          query={colourQuery} onQueryChange={setColourQuery} placeholder="Add colour" onClear={() => setColours([])}
          controls={colourList.current?.listId} activeDescendant={colourActive}
          onInputKeyDown={event => { colourList.current?.handleKey(event) }} />
        <MediaPickList ref={colourList} onActiveChange={setColourActive} label="Colour entries" choices={allColours} selected={colours} search="local" searchField={false} query={colourQuery}
          onToggle={value => setColours(current => [...toggleChoice(current, value, 'multi')])}
          onCreate={name => {
            const label = name.trim() || `New colour ${extra.length + 1}`
            const created: MediaChoice = { value: `example/colour/new-${extra.length + 1}`, label, group: 'This store' }
            setExtra(current => [...current, created]); setColours(current => [...current, created.value]); setColourQuery('')
          }} />
      </div>

      <h4>One entry: a single-pick list with pictures</h4>
      <div style={{ maxWidth: 480 }}>
        <MediaPickList label="Text with icon entries" choices={ICONS} selected={icon} mode="single" search="local"
          onToggle={value => setIcon(current => [...toggleChoice(current, value, 'single')])} />
      </div>

      <h4>Ordered products: rows with photos, and the picker dialog</h4>
      <div style={{ maxWidth: 480 }}>
        <MediaOrderedList label="Related products, in order" items={resolveChosen(products, PRODUCTS)} onChange={setProducts}
          onClear={() => setProducts([])} actions={<Button size="sm" onClick={() => setPickerOpen(true)}>Select products</Button>} />
      </div>
      <ResourcePickerDialog open={pickerOpen} title="Select products" noun={{ one: 'product', other: 'products' }} choices={PRODUCTS}
        initialSelected={products} search="local" query={productQuery} onQueryChange={setProductQuery}
        onDone={values => { setProducts(values); setPickerOpen(false) }} onCancel={() => setPickerOpen(false)} />
    </section>
  )
}
