import { createElement } from 'react'
import { renderToStaticMarkup as render } from 'react-dom/server'
import { expect, it } from 'vitest'
import { ProvenanceMark } from './provenanceMark'
import type { CellProvenance } from './provenance'
it('announces all eight marks and both text glyphs without making a tab stop', () => {
 const names = ['outdated','inherited','inheritedOverride','pinned','mapped','mappedShared','ai','aiStale','formula','refused'] as CellProvenance[]
 for (const provenance of names) {
   const html = render(createElement(ProvenanceMark, { provenance }))
   expect(html).toMatch(/^<span[^>]*role="img"[^>]*aria-label="[^"]+"/)
   expect(html).not.toMatch(/^<span[^>]*aria-hidden/); expect(html).not.toContain('tabindex=')
 }
 expect(render(createElement(ProvenanceMark, { provenance: 'own' }))).toBe('')
})
