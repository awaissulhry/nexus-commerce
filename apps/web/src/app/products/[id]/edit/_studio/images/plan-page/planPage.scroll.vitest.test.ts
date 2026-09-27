import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * The Media tab must always scroll (Owner, 2026-09-27: "the scroll on the images page is not working. It must not ever
 * happen again"). The studio's tab panel is a fixed-height flex box, so a tab surface without its own scroll area was
 * cut off and the wheel did nothing. Three layers, each checked here: the Media page and its states own their scroll;
 * the switch preview sits INSIDE the older tab's scroll area; and the frame's tab panel scrolls a tab that forgets.
 */
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
/** The declarations of one CSS rule (`.page { … }`), as written in the module. */
function rule(css: string, selector: string) {
  const match = css.match(new RegExp(`(?:^|\\n)${selector.replace('.', '\\.')}\\s*\\{([^}]*)\\}`))
  if (!match) throw new Error(`${selector} not found`)
  return match[1].replace(/\s+/g, ' ')
}
/* Up and down only: an overflow-y scroll area also scrolls sideways unless told not to, and a hidden tooltip at the
   right edge was enough to slide the Media page 15 px (2026-09-28). */
const ownsScroll = (declarations: string) => /flex: 1;/.test(declarations) && /min-height: 0;/.test(declarations)
  && /overflow-y: auto;/.test(declarations) && /overflow-x: hidden;/.test(declarations)

describe('the Media tab always scrolls', () => {
  it('the Media page, its loading state and the older tab each own a scroll area', () => {
    const plan = read('./planPage.module.css')
    expect(ownsScroll(rule(plan, '.page'))).toBe(true)
    expect(ownsScroll(rule(plan, '.state'))).toBe(true)
    expect(ownsScroll(rule(read('../images.module.css'), '.tab'))).toBe(true)
  })
  it('the switch preview is rendered inside the older tab (its scroll area), not above it', () => {
    const route = read('./MediaPlanRoute.tsx')
    expect(route).toMatch(/fallback\(<SwitchPanel /)
    expect(read('../ImagesTab.tsx').match(/\{header\}/g)?.length).toBe(3)
  })
  it('the tab\'s tooltips draw in a portal, so a hidden one cannot make the scroll area wider than the page', () => {
    expect(read('../ImagesTabRoute.tsx')).toMatch(/<TooltipPortalProvider><MediaPlanRoute /)
  })
  it('the studio frame scrolls a tab that forgets its own scroll area, instead of cutting it off', () => {
    const panel = rule(read('../../studio.module.css'), '.tabPanel')
    expect(panel).toMatch(/overflow-y: auto;/)
    expect(panel).not.toMatch(/overflow: hidden;/)
  })
})

/* Owner, 2026-09-27: "I still noticed Arial". Measured: the preview's "Shared photos would come from" line was Inter at the
   browser's 16 px (no DS size), so it read as a foreign font. Each Media surface sets the DS body size for its plain text. */
describe('the Media page text uses the DS body size', () => {
  it('the page, the switch preview and the loading state set --nds-font-size-base', () => {
    const plan = read('./planPage.module.css')
    for (const selector of ['.page', '.switch', '.state']) expect(rule(plan, selector)).toMatch(/font-size: var\(--nds-font-size-base\);/)
  })
})
