import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Pill } from '../primitives/Pill'
import { ChangeReview } from './ChangeReview'
import { RecordLayout } from './RecordLayout'
import { Sparkline } from './Sparkline'
import { SummaryTable } from './SummaryTable'
import { summaryCellAlign, summaryTableClass } from './summaryTableModel'
import { Timeline } from './Timeline'
import { keyValueRootProps } from '../lib/key-value'

/** 2026-10-26 — the Negative Targeting redesign's DS additions. Every default renders as before. */
const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el)

describe('Pill truncate', () => {
  it('one line with its words in their own span and the full words as title', () => {
    const out = html(h(Pill, { tone: 'warning', truncate: true, children: 'Partly blocked in 3 campaigns' }))
    expect(out).toBe('<span class="nds-pill warning is-truncated" title="Partly blocked in 3 campaigns"><span class="nds-pill-text">Partly blocked in 3 campaigns</span></span>')
  })
  it('keeps a title the caller gave; with an icon the words span carries the class', () => {
    const out = html(h(Pill, { tone: 'info', truncate: true, title: 'Whole', icon: h('svg'), children: 'Words' }))
    expect(out).toContain('title="Whole"')
    expect(out).toContain('<svg></svg><span class="nds-pill-text">Words</span>')
  })
  it('default unchanged', () => {
    expect(html(h(Pill, { tone: 'success', children: 'Running' }))).toBe('<span class="nds-pill success">Running</span>')
  })
})

describe('ChangeReview tick', () => {
  const props = { label: 'Review', selectedIds: [], onSelectionChange: () => {}, items: [{ id: 'a', label: 'Mode', status: 'New', note: 'Why', selectable: true, values: [] }] }
  it('draws a checkbox by default and none with tick={false}', () => {
    expect(html(h(ChangeReview, props))).toContain('type="checkbox"')
    expect(html(h(ChangeReview, { ...props, tick: false }))).not.toContain('type="checkbox"')
  })
})

describe('Timeline action', () => {
  it('draws the control at the end of the step head', () => {
    const out = html(h(Timeline, { label: 'Steps', steps: [{ key: 's', label: 'Added', tone: 'success', action: h('button', null, 'Undo') }] }))
    expect(out).toContain('nds-timeline-step tone-success has-action')
    expect(out).toMatch(/<span class="nds-timeline-head">.*<span class="nds-timeline-action"><button>Undo<\/button><\/span><\/span>/)
    expect(html(h(Timeline, { label: 'Steps', steps: [{ key: 's', label: 'Added', tone: 'success' }] }))).not.toContain('action')
  })
})

describe('SummaryTable', () => {
  it('class: compact and columns by default; roomy and stack-phone on request', () => {
    expect(summaryTableClass({})).toBe('nds-summary-table')
    expect(summaryTableClass({ density: 'roomy', stackOnPhone: true })).toBe('nds-summary-table roomy stack-phone')
  })
  it('align: a column left undefined keeps the default rule', () => {
    expect(summaryCellAlign(undefined, 2)).toBeUndefined()
    expect(summaryCellAlign([undefined, 'right'], 0)).toBeUndefined()
    expect(summaryCellAlign([undefined, 'right'], 1)).toBe('right')
  })
  it('stackOnPhone labels each cell with its column; default markup unchanged', () => {
    const rows = [{ id: 'r', cells: ['Jackets', '€1'] }]
    expect(html(h(SummaryTable, { label: 'T', columns: ['Campaign', 'Spend'], rows })))
      .toBe('<table class="nds-summary-table" aria-label="T"><thead><tr><th scope="col">Campaign</th><th scope="col">Spend</th></tr></thead><tbody><tr><td>Jackets</td><td>€1</td></tr></tbody></table>')
    const out = html(h(SummaryTable, { label: 'T', columns: ['Campaign', 'Spend'], rows, stackOnPhone: true, align: ['right'] }))
    expect(out).toContain('<td data-align="right" data-label="Campaign">Jackets</td><td data-label="Spend">€1</td>')
  })
})

describe('Sparkline fluid', () => {
  it('fills the width: 100% wide, stretched viewBox, round-cap dots', () => {
    const out = html(h(Sparkline, { values: [1, null, 3], label: 'Spend', fluid: true, height: 30 }))
    expect(out).toContain('class="nds-spark is-fluid"')
    expect(out).toContain('style="height:30px"')
    expect(out).toContain('width="100%"')
    expect(out).toContain('preserveAspectRatio="none"')
    expect(out).toContain('class="nds-spark-cap"')
    expect(out).not.toContain('<circle')
  })
  it('default unchanged: fixed box and circles', () => {
    const out = html(h(Sparkline, { values: [1, null, 3], label: 'Spend' }))
    expect(out).toContain('style="width:88px;height:22px"')
    expect(out).toContain('<circle')
    expect(out).not.toContain('preserveAspectRatio')
  })
})

describe('RecordLayout', () => {
  it('main then aside, the aside a landmark only when named', () => {
    expect(html(h(RecordLayout, { main: 'M', aside: 'A' })))
      .toBe('<div class="nds-record-layout"><div class="nds-record-layout-main">M</div><div class="nds-record-layout-aside">A</div></div>')
    expect(html(h(RecordLayout, { main: 'M', aside: 'A', asideLabel: 'Status' }))).toContain('<aside class="nds-record-layout-aside" aria-label="Status">A</aside>')
  })
})

describe('KeyValue phoneColumns', () => {
  it('marks two phone columns only for a 2- or 3-column list', () => {
    expect(keyValueRootProps({ columns: 3, phoneColumns: 2 })['data-phone-columns']).toBe(2)
    expect(keyValueRootProps({ columns: 1, phoneColumns: 2 })['data-phone-columns']).toBeUndefined()
    expect(keyValueRootProps({ columns: 3 })).toEqual({ className: 'nds-kv', 'data-columns': 3 })
  })
})
