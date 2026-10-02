/**
 * MCP full control C9 — Settings › AI › Claude › Activity at phone width (the 2026-10-02 browser check, 390 px).
 *
 * The activity was a NexusGrid whose Undo column sat off-screen at 390 px (and was not reached by Tab). It is now a
 * list: each row's Undo is a Tab stop in the order shown, and below a phone-sized width each row stacks with its Undo
 * beside the row's first line, never past the right edge. Rendered HTML (node SSR) and the page's own stylesheet.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ActivityRows } from './ActivityPanel'
import type { ActivityRow } from './claudeWords'

const row = (runId: string, over: Partial<ActivityRow> = {}): ActivityRow => ({
  runId, at: new Date(Date.now() - 21 * 60_000).toISOString(), who: { userId: 'user-1', name: 'Test Person' },
  connection: { id: 'grant_123456789', app: 'Claude' }, tool: 'set-product-tags', outcome: 'approved', ...over,
})
const ROWS = [
  row('run-1', { change: { id: 'change-1', reversibility: 'full', undo: 'possible', outbound: false } }),
  row('run-2', { tool: 'product-search', outcome: 'read' }),
  row('run-3', { tool: 'set-price', change: { id: 'change-3', reversibility: 'full', undo: 'possible', outbound: true } }),
]
const html = () => renderToStaticMarkup(createElement(ActivityRows, { rows: ROWS, busy: false, onUndo: () => undefined }))

describe('Activity: each Undo is in its row and a Tab away', () => {
  it('one Undo per change that can be put back, each a Tab stop, in the order shown; no grid', () => {
    const markup = html()
    expect(markup).not.toMatch(/role="grid"|ag-root|ag-header/)
    const undos = [...markup.matchAll(/<button\b([^>]*)>/g)].map(([, attrs]) => attrs).filter((attrs) => /aria-label="Undo the /.test(attrs))
    expect(undos).toHaveLength(2)
    for (const attrs of undos) expect(attrs).not.toMatch(/tabindex="-1"|disabled=""/)
    expect(markup.indexOf('Undo the set-product-tags change')).toBeLessThan(markup.indexOf('Undo the set-price change'))
  })

  it('each row says when, who, over which connection, which tool, what became of it', () => {
    const markup = html()
    for (const text of ['21 min ago', 'Test Person', 'Claude', 'set-product-tags', 'Can be undone']) expect(markup).toContain(text)
  })
})

describe('Activity at phone width: each row stacks, its Undo stays on screen', () => {
  const css = readFileSync(join(import.meta.dirname, 'claude.css'), 'utf8')
  const narrow = css.match(/@container claude-activity \(max-width: (\d+)px\) \{([\s\S]*?)\n\}/)

  it('the list measures its own width and stacks below a phone-sized width', () => {
    expect(css).toMatch(/\.claude-activity \{[^}]*container: claude-activity \/ inline-size/)
    expect(narrow, 'a @container claude-activity (max-width: …px) block').not.toBeNull()
    expect(Number(narrow![1])).toBeGreaterThanOrEqual(480)
    expect(narrow![2]).toMatch(/\.claude-activity-head \{ display: none; \}/)
  })

  it('stacked, the Undo takes the first line\'s right end: the row\'s content in one column, Undo in its own', () => {
    const block = narrow![2]
    expect(block).toMatch(/\.claude-activity-row \{[^}]*grid-template-columns: minmax\(0, 1fr\) auto/)
    expect(block).toMatch(/\.claude-activity-row > :not\(\.claude-activity-undo\) \{ grid-column: 1; \}/)
    expect(block).toMatch(/\.claude-activity-undo \{[^}]*grid-column: 2;[^}]*grid-row: 1/)
  })
})
