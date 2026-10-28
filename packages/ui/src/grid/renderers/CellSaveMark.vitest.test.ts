import { createElement } from 'react'
import { renderToStaticMarkup as render } from 'react-dom/server'
import { expect, it } from 'vitest'
import { CellSaveMark } from './CellSaveMark'
it('gives every unresolved save a distinct visible glyph and accessible name without a tab stop', () => {
 const html = ['saving', 'waiting', 'unknown'].map(state => render(createElement(CellSaveMark, { state: state as 'saving' })))
 for (const s of html) { expect(s).toContain('role="img"'); expect(s).toContain('aria-label='); expect(s).not.toContain('tabindex=') }
 expect(new Set(html.map(s => s.replace(/<[^>]+>/g, ''))).size).toBe(3)
 for (const state of [null, 'saved', 'refused'] as const) expect(render(createElement(CellSaveMark, { state }))).toBe('')
})
