import { createElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { DesignScreen } from '../../../../lib/design/design-screen'
import { LOCALES } from '../../../../lib/i18n/locales'
import { render, textOf } from '../../../../lib/record-thread/parts/testing'
import type { Order } from '../api'
import { designScreen } from './fixtures'
import type { OrderRecordModel } from './record-model'
import { LinesTab } from './view/LinesTab'

// The DS Modal draws into a portal once hydrated, never on the server: here it draws in place (Review and save is one).
vi.mock('@nexus/ui/components', async (original) => {
  const actual = await original<typeof import('@nexus/ui/components')>()
  const Modal = ({ open, title, children, footer }: { open: boolean; title?: unknown; children?: unknown; footer?: unknown }) => (open ? createElement('section', { role: 'dialog', 'data-modal': '' }, createElement('h2', null, title as never), children as never, footer as never) : null)
  return { ...actual, Modal }
})

/**
 * F-OL-10 (Order LINES lane): SCR-039 shows the new Lines tab for every reader and state the lead asked for — Sales (no money),
 * Read-only (no box, no button, no ⋯), 375, a partly shipped order (held in words), two people (the banner and Keep mine / Take
 * theirs), Review and save with the tick on and off. Each case is drawn here as the tab alone. Every name and number is made up.
 */

const caseOf = (id: string) => {
  const item = (designScreen as DesignScreen<unknown>).cases.find((entry) => entry.id === id)
  expect(item, id).toBeDefined()
  return (item!.model as { record: OrderRecordModel }).record
}
const drawTab = (id: string, locale: (typeof LOCALES)[number] = 'en') => {
  const record = caseOf(id)
  return render(createElement(LinesTab, { order: (record.order as { value: Order }).value, model: record }), locale)
}

describe('F-OL-10: the Lines cases of SCR-039', () => {
  it('every asked case is there, each once', () => {
    const ids = designScreen.cases.map((item) => item.id)
    for (const id of ['lines-sales', 'lines-read-only', 'lines-phone', 'lines-partly-shipped', 'lines-moved', 'lines-review', 'lines-review-tick-off']) expect(ids.filter((entry) => entry === id), id).toHaveLength(1)
  })

  it('Sales: no money anywhere, one line why (en, it)', () => {
    for (const locale of LOCALES) {
      const text = textOf(drawTab('lines-sales', locale))
      expect(text).not.toMatch(/€|EUR/)
      expect(text).toContain(locale === 'en' ? 'prices are set by someone who sees them' : 'i prezzi li imposta chi li vede')
    }
  })

  it('Read-only: plain numbers — no box, no Add a style, no ⋯, no save bar', () => {
    const html = drawTab('lines-read-only')
    expect(html).not.toContain('<input')
    expect(textOf(html)).not.toContain('Add a style')
    expect(html).not.toMatch(/aria-label="Actions for line/)
    expect(html).not.toContain('role="region" aria-label="Edit mode"')
  })

  it('partly shipped: the plain numbers and the held words; two people: who saved, Keep mine / Take theirs in the cell', () => {
    const shipped = drawTab('lines-partly-shipped')
    expect(shipped).not.toContain('<input')
    expect(textOf(shipped)).toContain('Its lines are fixed once anything shipped')
    const moved = textOf(drawTab('lines-moved'))
    for (const words of ['Bea Esempio', 'Keep mine', 'Take theirs']) expect(moved, words).toContain(words)
  })

  it('Review and save: the tick on by default when the total goes up; taken off, "Not ticked: they are not asked." (en, it)', () => {
    const on = drawTab('lines-review')
    expect(on).toMatch(/<input(?=[^>]*type="checkbox")(?=[^>]*checked="")[^>]*>/)
    const off = drawTab('lines-review-tick-off')
    expect(textOf(off)).toContain('Not ticked: they are not asked.')
    expect(textOf(drawTab('lines-review-tick-off', 'it'))).not.toMatch(/\breview\.[a-zA-Z.]+/)
  })

  it('375: the changing tab with its save bar (the phone layout is the same table: lines.css below 640 px)', () => {
    const html = drawTab('lines-phone')
    expect(textOf(html)).toContain('3 changes not saved')
    expect(designScreen.cases.find((item) => item.id === 'lines-phone')?.note).toContain('375')
  })
})
