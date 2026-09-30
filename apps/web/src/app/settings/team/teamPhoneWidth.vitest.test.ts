import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * Team & Access at phone width (2026-09-30). At 390 px every member card and its "Manage access" ran 180 px past the
 * right edge, the owner's view included: the page grid's `auto` column grew to its widest unbreakable line (a member's
 * email), and the card head squeezed that email to 87 px beside its action. Measured fixed in a browser at 390 and
 * 1280 px; these are the three rules that fix it.
 */
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
/** Every declaration block of `selector` in `css` (top level or inside an at-rule), joined. */
function rules(css: string, selector: string) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return [...css.matchAll(new RegExp(`(?:^|[\\n}])\\s*${escaped}\\s*\\{([^}]*)\\}`, 'g'))].map((m) => m[1].replace(/\s+/g, ' ')).join(' ')
}

describe('Team & Access fits a phone', () => {
  it('the page is one column as wide as the page and never wider', () => {
    expect(rules(read('../../profiles/profiles.css'), '.business-profiles')).toMatch(/grid-template-columns: minmax\(0, 1fr\);/)
  })

  it('a card head breaks a long word at the card edge, and at phone width puts its action under the text', () => {
    const css = read('../../../design-system/styles/components.css')
    expect(rules(css, '.nds-card-head .t, .nds-card-head .d')).toMatch(/overflow-wrap: break-word;/)
    const phone = css.slice(css.indexOf('@media (max-width: 600px) {\n  .nds-card-head.stacked'))
    expect(phone.length).toBeGreaterThan(0)
    expect(rules(phone, '.nds-card-head.stacked')).toMatch(/flex-wrap: wrap;/)
    expect(rules(phone, '.nds-card-head.stacked > .nds-card-headmain')).toMatch(/flex: 1 1 12rem;/)
  })

  it('the Factory copy of the card rules says the same', () => {
    const web = read('../../../design-system/styles/components.css')
    const factory = read('../../../../../factory/src/design-system/styles/components.css')
    const cardRules = (css: string) => css.slice(css.indexOf('.nds-card-head .d {'), css.indexOf('.nds-card-body {'))
    expect(cardRules(factory)).toBe(cardRules(web))
  })
})
