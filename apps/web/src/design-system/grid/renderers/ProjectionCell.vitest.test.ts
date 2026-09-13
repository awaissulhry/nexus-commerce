import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ICellRendererParams } from 'ag-grid-community'

import { ProjectionCell, type ProjectionCellParams, type ProjectionFacts } from './ProjectionCell'
import { projectionMeta } from './projection'

/**
 * These render the real component in Node (`react-dom/server`), which is how the rest of this
 * workspace tests a `.tsx` from a `.ts` suite — the vitest environment is `node` and there is no
 * jsdom. That is enough for every claim below: they are about the MARKUP the cell emits.
 *
 * What is deliberately NOT asserted here: colour. The dot's colour comes from a CSS custom
 * property keyed on `data-tone`, so a test that read a hex would be testing its own fixture. The
 * tone DELEGATION is asserted in `projection.vitest.test.ts`, against `readinessMeta` itself.
 */
const params = (
  value: boolean | null | undefined,
  facts: ProjectionFacts | null,
  extra: Partial<ProjectionCellParams> = {},
) =>
  ({
    value,
    colDef: { headerName: 'eBay · IT' },
    facts: () => facts,
    ...extra,
  }) as unknown as ICellRendererParams & ProjectionCellParams

const html = (p: ICellRendererParams & ProjectionCellParams) =>
  renderToStaticMarkup(createElement(ProjectionCell, p))

describe('ProjectionCell · the five states', () => {
  it('paints a solid dot, the §9 word and a live tick for a listed variant', () => {
    const out = html(params(true, { state: 'listed' }, { onToggle: () => {} }))
    expect(out).toContain('nds-projcell-dot solid')
    expect(out).toContain('data-tone="info"')
    expect(out).toContain('>Listed<')
    expect(out).toContain('type="checkbox"')
    expect(out).toContain('checked=""')
    expect(out).not.toContain('aria-disabled')
  })

  it('paints a hollow dot for a draft, and no dot at all for excluded', () => {
    expect(html(params(true, { state: 'draft' }, { onToggle: () => {} }))).toContain('nds-projcell-dot hollow')
    const excluded = html(params(false, { state: 'excluded' }, { onToggle: () => {} }))
    expect(excluded).not.toContain('nds-projcell-dot')
    expect(excluded).toContain('>Excluded<')
    // Excluded is quiet, but its tick is the one live control on the row (§4.3).
    expect(excluded).toContain('nds-projcell muted')
    expect(excluded).not.toContain('held')
  })

  it('HOLDS the tick on "Not set up" — focusable, with the reason on it, never `disabled`', () => {
    const out = html(params(false, { state: 'not-set-up' }, { onToggle: () => {} }))
    expect(out).toContain('aria-disabled="true"')
    expect(out).toContain(`title="${projectionMeta('not-set-up').hint}"`)
    expect(out).toContain('nds-projcell muted held')
    // The attribute that swallows focus, click and tooltip is the defect; it must not be here.
    expect(out).not.toMatch(/<input[^>]*\sdisabled/)
    expect(out).toContain('>Not set up<')
  })

  it('uses the shared missing-value warning tone on "Needs a value"', () => {
    const out = html(params(true, { state: 'needs-value' }, { onToggle: () => {} }))
    expect(out).toContain('data-tone="warning"')
    expect(out).toContain('nds-projcell-dot solid')
    expect(out).toContain('>Needs a value<')
  })
})

describe('ProjectionCell · the hold, and who may set it', () => {
  it('holds every tick in a column with no onToggle, and says why', () => {
    const out = html(params(true, { state: 'listed' }, { readOnlyReason: 'Ask an admin to change this' }))
    expect(out).toContain('aria-disabled="true"')
    expect(out).toContain('title="Ask an admin to change this"')
  })

  it('lets a row override the state with its own reason', () => {
    const out = html(
      params(true, { state: 'listed', heldReason: 'This listing is locked while it publishes' }, { onToggle: () => {} }),
    )
    expect(out).toContain('title="This listing is locked while it publishes"')
  })

  it('never renders a tick, or a hold, on the parent row', () => {
    const out = html(params(null, { detail: 'B0F7J163XJ', note: 'Parent ASIN' }))
    expect(out).not.toContain('type="checkbox"')
    expect(out).not.toContain('held')
    expect(out).not.toContain('aria-disabled')
    // The canvas's order: the mono id leads, the note takes the right edge.
    expect(out.indexOf('B0F7J163XJ')).toBeLessThan(out.indexOf('Parent ASIN'))
    expect(out).toContain('nds-projcell-detail')
    expect(out).toContain('nds-projcell-note')
  })
})

describe('ProjectionCell · an include that has not landed yet (VP.4)', () => {
  it('marks the cell busy and HOLDS the tick, so a second click cannot race the first write', () => {
    const out = html(params(true, { state: 'listed', busy: true }, { onToggle: () => {} }))
    expect(out).toContain('aria-busy="true"')
    expect(out).toContain('nds-projcell')
    expect(out).toContain('busy')
    expect(out).toContain('aria-disabled="true"')
    expect(out).toContain('title="Saving this change…"')
  })

  it("lets the row's own reason win over the busy sentence", () => {
    const out = html(params(true, { state: 'listed', busy: true, heldReason: 'Publishing' }, { onToggle: () => {} }))
    expect(out).toContain('title="Publishing"')
    expect(out).not.toContain('Saving this change')
  })

  it("takes the row's accessible name over the column's", () => {
    const out = html(
      params(true, { state: 'listed', includedLabel: 'Include GALE-JACKET-BLK-XXS on eBay · IT' }, {
        onToggle: () => {},
        label: () => 'the column would have said this',
      }),
    )
    expect(out).toContain('aria-label="Include GALE-JACKET-BLK-XXS on eBay · IT"')
    expect(out).not.toContain('the column would have said this')
  })

  it('puts a title on the cell ONLY when the row has something the word does not say', () => {
    // 21 rows × 5 channels = 105 tooltips if this defaulted. The word is already in the cell.
    expect(html(params(true, { state: 'listed' }, { onToggle: () => {} }))).not.toMatch(/<span[^>]*\stitle=/)
    expect(html(params(true, { state: 'listed', title: 'Live since 4 March' }, { onToggle: () => {} }))).toContain(
      'title="Live since 4 March"',
    )
  })
})

describe('ProjectionCell · what it refuses to invent', () => {
  it('renders nothing when the column reader answers nothing', () => {
    // "I have no facts" is a column defect. Rendering "Listed" would be a lie; a dash would claim
    // a measured absence. Silence is the only honest answer a renderer can give here.
    expect(html(params(true, null))).toBe('')
  })

  it('names an unknown state rather than showing one of ours', () => {
    const out = html(params(true, { state: 'shipped' as never }, { onToggle: () => {} }))
    expect(out).toContain('>shipped<')
    expect(out).not.toContain('>Listed<')
    expect(out).not.toContain('nds-projcell-dot')
    // An unknown state cannot be toggled: nobody knows what the tick would mean.
    expect(out).toContain('aria-disabled="true"')
  })

  it('gives every tick an accessible name, defaulting to the column', () => {
    expect(html(params(true, { state: 'listed' }, { onToggle: () => {} }))).toContain('aria-label="Include on eBay · IT"')
    expect(
      html(params(true, { state: 'listed' }, { onToggle: () => {}, label: () => 'Include GALE-JACKET-BLK-XXS on eBay · IT' })),
    ).toContain('aria-label="Include GALE-JACKET-BLK-XXS on eBay · IT"')
  })

  it('drops an empty detail and an empty note instead of painting an empty slot', () => {
    const out = html(params(true, { state: 'listed', detail: '', note: '' }, { onToggle: () => {} }))
    expect(out).not.toContain('nds-projcell-detail')
    expect(out).not.toContain('nds-projcell-note')
  })
})
