/**
 * Lead review (2026-10-11, `hds-390-picker-in-dialog.png`): an option whose label wrapped at 390 px had its match chip
 * centred between the lines, below the first one. A TEXT chip in the leading slot now sits on the label's first line
 * (baseline); flags and icons keep the centred row. Apps/web tests have no layout, so the rule is read from the source.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const web = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const factory = (path: string) => readFileSync(new URL(`../../../../factory/src/design-system/${path}`, import.meta.url), 'utf8')

describe('ListboxPanel rows with a text chip', () => {
  it('align on the first line only when the leading node is a Tag', () => {
    const css = web('components/listbox-rows.css')
    expect(css).toMatch(/button\[role="option"\]:has\(> \.nds-listbox-lead > \.nds-tag\)\s*\{\s*align-items:\s*baseline;/)
  })
  it('the trigger\'s label starts right after a leading chip (S6), not centred between the chip and the chevron', () => {
    expect(web('components/listbox-rows.css')).toMatch(/\.nds-listbox-btn > \.nds-listbox-lead \+ span \{ flex: 1 1 auto; min-width: 0; \}/)
  })
  it('the panel loads the rule, and Factory carries the same files', () => {
    expect(web('components/ListboxPanel.tsx')).toContain("import './listbox-rows.css'")
    expect(factory('components/listbox-rows.css')).toBe(web('components/listbox-rows.css'))
    expect(factory('components/ListboxPanel.tsx')).toBe(web('components/ListboxPanel.tsx'))
  })
})
