import { createElement } from 'react'
import { renderToStaticMarkup as render } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ProvenanceMark } from './provenanceMark'
import { provenanceLabel, provenanceTooltip, type CellProvenance } from './provenance'

const MARKED: CellProvenance[] = ['outdated', 'inherited', 'inheritedOverride', 'pinned', 'mapped', 'mappedShared', 'ai', 'aiStale',
  'formula', 'refused', 'pending', 'attention', 'listingValue', 'listingLevel']

/** The mark's own attributes, read off its outer span. */
function attrs(html: string): { label: string | null; title: string | null; cls: string } {
  const open = html.match(/^<span([^>]*)>/)?.[1] ?? ''
  const read = (name: string) => open.match(new RegExp(`${name}="([^"]*)"`))?.[1] ?? null
  return { label: read('aria-label'), title: read('title'), cls: read('class') ?? '' }
}
/** renderToStaticMarkup escapes `'` and `&`; compare against the escaped form. */
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/'/g, '&#x27;').replace(/"/g, '&quot;')

it('announces every mark without making a tab stop, and draws nothing for own', () => {
  for (const provenance of MARKED) {
    const html = render(createElement(ProvenanceMark, { provenance }))
    expect(html).toMatch(/^<span[^>]*role="img"[^>]*aria-label="[^"]+"/)
    expect(html).not.toMatch(/^<span[^>]*aria-hidden/); expect(html).not.toContain('tabindex=')
  }
  expect(render(createElement(ProvenanceMark, { provenance: 'own' }))).toBe('')
})

describe('one text for the hover AND the screen reader (2026-10-04)', () => {
  it('aria-label equals title for every member, with no source, with a source and with a sentence', () => {
    for (const provenance of MARKED) {
      for (const props of [{}, { from: 'GALE-JACKET' }, { tooltip: 'The exact sentence.' }, { from: 'GALE-JACKET', tooltip: 'The exact sentence.' }]) {
        const a = attrs(render(createElement(ProvenanceMark, { provenance, ...props })))
        expect([provenance, a.label]).toEqual([provenance, a.title])
        expect(a.label).not.toBe('')
      }
    }
  })
  /* 2026-10-04 (fix C) — ONE sentence per mark, for every member: "label — from" read two ways (on the Shared scope the
     word after the dash named what the value follows, on a channel scope where the pin lives). */
  it('reads the member’s one sentence with its source in it, and a given sentence wins', () => {
    expect(attrs(render(createElement(ProvenanceMark, { provenance: 'inherited', from: 'GALE-JACKET' }))).label)
      .toBe('Inherited from GALE-JACKET — edit to give this row its own value')
    expect(attrs(render(createElement(ProvenanceMark, { provenance: 'pinned', from: 'the Shared product' }))).label)
      .toBe('Pinned on this row — it no longer follows the Shared product')
    expect(attrs(render(createElement(ProvenanceMark, { provenance: 'pinned' }))).label).toBe('Pinned on this row — it no longer follows the layer above')
    expect(attrs(render(createElement(ProvenanceMark, { provenance: 'formula', from: '=UPPER(title)' }))).label)
      .toBe('Calculated by a formula on this cell — =UPPER(title). Edit the cell to change the formula')
    const sentence = 'Pinned at Dutch · Amazon · BE · pin — changes to the shared language text do not replace this value'
    expect(attrs(render(createElement(ProvenanceMark, { provenance: 'pinned', from: 'x', tooltip: sentence }))).label).toBe(sentence)
  })
  it('with no tooltip, EVERY member’s text is its provenanceTooltip sentence — never "label — from"', () => {
    for (const provenance of MARKED) {
      for (const from of [undefined, null, 'GALE-JACKET']) {
        const a = attrs(render(createElement(ProvenanceMark, { provenance, from })))
        expect([provenance, from, a.label]).toEqual([provenance, from, esc(provenanceTooltip(provenance, from))])
        if (from) expect(a.label).not.toBe(esc(`${provenanceLabel(provenance)} — ${from}`))
      }
    }
  })
  /* #780 / scripts/check-editor-open.mjs: a refused mark's title is the server's reason VERBATIM — and now so is its name. */
  it('a refusal carries the server reason verbatim, with no label in front', () => {
    const reason = '"purple" is not an allowed value for Colour — choose one of: Black, Yellow'
    const a = attrs(render(createElement(ProvenanceMark, { provenance: 'refused', from: reason })))
    expect(a.title).toBe(esc(reason)); expect(a.label).toBe(esc(reason))
    // No reason at all (a host that sets the member without one): the member's own sentence, never an empty name.
    expect(attrs(render(createElement(ProvenanceMark, { provenance: 'refused' }))).label).toBe('This formula produced no value')
  })
})

describe('the four channel members', () => {
  const cases: [CellProvenance, string, string, string][] = [
    ['pending', 'Waits for Publish', 'nds-cell-prov-pending', 'lucide-clock'],
    ['attention', 'Needs attention', 'nds-cell-prov-attention', 'lucide-circle-alert'],
    ['listingValue', 'Listing value', 'nds-cell-prov-listing', 'lucide-store'],
    ['listingLevel', 'One value for the whole listing', 'nds-cell-prov-listing-level', 'lucide-layers'],
  ]
  it('each has its label, its class and its own glyph', () => {
    for (const [provenance, label, cls, glyph] of cases) {
      const html = render(createElement(ProvenanceMark, { provenance }))
      const a = attrs(html)
      expect([provenance, provenanceLabel(provenance)]).toEqual([provenance, label])
      expect(a.cls).toBe(`nds-cell-prov ${cls}`)
      expect(html).toContain(glyph)
    }
  })
  /* 2026-10-04 (A2): with no `tooltip`, these four read their WHOLE sentence — never "label — from" — so every host
     (the sheet, the bullets cell, the catalog, the legend) says the same words without passing `tooltip`. */
  it('with no tooltip, the mark text is the provenanceTooltip sentence, with and without a source', () => {
    for (const [provenance] of cases) {
      for (const from of [undefined, null, 'GALE-JACKET']) {
        const a = attrs(render(createElement(ProvenanceMark, { provenance, from })))
        expect([provenance, from, a.label]).toEqual([provenance, from, esc(provenanceTooltip(provenance, from))])
      }
    }
  })
  it('a server sentence for pending / attention is the whole text, verbatim', () => {
    expect(attrs(render(createElement(ProvenanceMark, { provenance: 'pending', from: 'Live until you publish: Black' }))).label).toBe('Live until you publish: Black')
    expect(attrs(render(createElement(ProvenanceMark, { provenance: 'attention', from: 'Saved, not sent' }))).label).toBe('Saved, not sent')
    expect(attrs(render(createElement(ProvenanceMark, { provenance: 'pending' }))).label).toBe('Saved in Nexus — the channel gets this value when you publish')
    expect(attrs(render(createElement(ProvenanceMark, { provenance: 'listingLevel', from: 'GALE-JACKET' }))).label)
      .toBe('One value for the whole listing, from GALE-JACKET — setting or clearing it here sets it for every variation')
  })
  it('a given tooltip still wins for the four', () => {
    for (const [provenance] of cases) expect(attrs(render(createElement(ProvenanceMark, { provenance, from: 'x', tooltip: 'Exact words' }))).label).toBe('Exact words')
  })
  it('the other members read their sentence too — no "label — from" left', () => {
    expect(attrs(render(createElement(ProvenanceMark, { provenance: 'mappedShared', from: 'the Shared product' }))).label)
      .toBe('Derived per product from the Shared product — every alias of this product shares this value, so editing one changes all of them')
    // With a source: a machine translation of an older source text — the fact only, no advice to approve or compare.
    expect(attrs(render(createElement(ProvenanceMark, { provenance: 'aiStale', from: 'the source text' }))).label)
      .toBe('Translated by machine from an older value — the source text has changed since')
    expect(attrs(render(createElement(ProvenanceMark, { provenance: 'ai', from: 'the source text' }))).label)
      .toBe('Translated by machine and not reviewed yet')
    // No source: an AI draft of THIS cell (PES.8) — the AI drafts review approves it.
    expect(attrs(render(createElement(ProvenanceMark, { provenance: 'ai' }))).label)
      .toBe('Drafted by AI and not yet approved — review before it counts as confirmed')
    // No source: an AI draft of THIS cell — approving it would overwrite the edit made since (PES.8).
    expect(attrs(render(createElement(ProvenanceMark, { provenance: 'aiStale' }))).label)
      .toBe('Drafted by AI from an older value — this cell has changed since. Approving this overwrites that change')
  })
  /* Ruling #16: a new member is a new GLYPH. No two marks may draw the same icon. */
  it('no two members draw the same glyph', () => {
    const glyphOf = (p: CellProvenance) => {
      const html = render(createElement(ProvenanceMark, { provenance: p }))
      return html.match(/lucide-([a-z0-9-]+)"/g)?.filter((c) => c !== 'lucide-"')?.join() || html.replace(/<[^>]+>/g, '')
    }
    const glyphs = MARKED.map(glyphOf)
    expect(new Set(glyphs).size).toBe(MARKED.length)
  })
})
