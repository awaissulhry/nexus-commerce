/**
 * MCP.12 — the fleet's button family, and the light pin it depends on.
 *
 * `.acr-btn` lost its rules when control-room.css moved its own buttons to the DS `Button`, and every fleet page kept
 * drawing ~100 buttons with it: they rendered as bare browser buttons. Its look now lives once, in fleet-pages.css.
 * The fleet is light-only on purpose, so a rule here may read a token only if `.dark` leaves it alone or the fleet's
 * pin sets it back to its light value — otherwise a dark OS paints light text on this light ground. Held here:
 *
 *   1. every `.acr-btn` modifier a fleet page uses has a rule (a bare modifier with no rule is the shape that hid
 *      `.h10-pill.bad`), and the base is scoped to the fleet surface and its portals;
 *   2. every `--nds-*` those rules and the Approvals page's row error read is dark-safe, as defined above.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const FLEET = import.meta.dirname
const SRC = join(FLEET, '..', '..')
const read = (path: string) => readFileSync(path, 'utf8')
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '')

const pages = stripComments(read(join(FLEET, 'fleet-pages.css')))
const approvals = stripComments(read(join(FLEET, 'approvals', 'approvals.css')))
const tokens = stripComments(read(join(SRC, 'design-system', 'styles', 'tokens.css')))

/** The declarations of every rule whose selector list matches. */
function rulesFor(css: string, selector: RegExp): string[] {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((m) => selector.test(m[1])).map((m) => m[2])
}
const tokensIn = (bodies: string[]) => new Set(bodies.flatMap((b) => [...b.matchAll(/var\((--nds-[a-z0-9-]+)\)/g)].map((m) => m[1])))
const declared = (body: string) => new Set([...body.matchAll(/(--nds-[a-z0-9-]+)\s*:/g)].map((m) => m[1]))

/** Tokens `.dark` redefines — in the DS, and in the app chrome's dark block, which wraps every page. */
const darkBlock = rulesFor(tokens, /^\s*\.dark\b/).join('\n')
const shell = stripComments(read(join(SRC, 'app', '_shared', 'shared-shell.css')))
const chromeDark = rulesFor(shell, /^\s*\.dark \.nds-chrome-host\b/).join('\n')
const flipsInDark = new Set([...declared(darkBlock), ...declared(chromeDark)])
/** Tokens the fleet's light pin (and its portals) sets back. */
const fleetPin = declared(rulesFor(pages, /^\s*\.fleet-surface,\s*\.fleet-portal\s*$/).join('\n'))
/** Tokens the Approvals page pins for itself. */
const pagePin = declared(rulesFor(approvals, /^\s*\.aq-page\s*$/).join('\n'))

function tsxUnder(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) tsxUnder(path, out)
    else if (entry.endsWith('.tsx')) out.push(path)
  }
  return out
}

describe('MCP.12 — `.acr-btn` has its look back, once, for every fleet page', () => {
  it('the base is scoped to the fleet surface and its portals, at the DS sm tier', () => {
    const base = rulesFor(pages, /^\s*\.fleet-surface \.acr-btn,\s*\.fleet-portal \.acr-btn\s*$/)
    expect(base).toHaveLength(1)
    expect(base[0]).toContain('min-height: var(--nds-control-h-sm)')
    expect(base[0]).toContain('font-size: var(--nds-font-size-sm-plus)')
    expect(base[0]).toContain('color: var(--nds-text)')
    // A banner's button keeps the banner's tone; nowhere else inherits (an empty state's grey measured 4.4:1).
    expect(rulesFor(pages, /^\s*\.fleet-surface \.acr-banner \.acr-btn,\s*\.fleet-portal \.acr-banner \.acr-btn\s*$/)).toEqual([expect.stringContaining('color: inherit')])
  })

  it('every modifier a fleet page uses has a rule', () => {
    const used = new Set<string>()
    for (const file of tsxUnder(FLEET)) {
      for (const m of read(file).matchAll(/acr-btn((?: [a-z][a-z0-9-]*)+)/g)) {
        for (const cls of m[1].trim().split(' ')) if (!/^(as|wf|aq|ap|sbw|sba)-/.test(cls)) used.add(cls)
      }
    }
    expect([...used].sort()).toEqual(['ghost', 'go', 'primary', 'stop'])
    for (const modifier of used) {
      expect(rulesFor(pages, new RegExp(`\\.fleet-surface \\.acr-btn\\.${modifier}\\b`)).length, modifier).toBeGreaterThan(0)
    }
  })

  it('the Approvals page no longer carries its own copy of the base', () => {
    expect(rulesFor(approvals, /^\s*\.aq-page \.acr-btn\s*$/)).toEqual([])
  })
})

describe('MCP.12 — what those rules and the Approvals page read stays light under a dark OS', () => {
  it('the dark block is read (control)', () => {
    expect(declared(chromeDark).has('--nds-warning')).toBe(true)
    expect(flipsInDark.has('--nds-success-strong')).toBe(true)
    expect(flipsInDark.has('--nds-danger-strong')).toBe(true)
    expect(flipsInDark.size).toBeGreaterThan(20)
  })

  it('every token the `.acr-btn` family reads is dark-safe', () => {
    const read = tokensIn(rulesFor(pages, /\.acr-btn/))
    expect(read.size).toBeGreaterThan(8)
    const unsafe = [...read].filter((t) => flipsInDark.has(t) && !fleetPin.has(t))
    expect(unsafe).toEqual([])
  })

  it('the returned-request Banner (warning and danger tones) is dark-safe on the Approvals page', () => {
    const components = stripComments(read(join(SRC, 'design-system', 'styles', 'components.css')))
    const banner = tokensIn(rulesFor(components, /\.nds-banner(\.(warning|danger))?(\s|$|,)|\.nds-banner-(icon|body|desc|title)\b/))
    expect([...banner]).toEqual(expect.arrayContaining(['--nds-warning-soft', '--nds-warning-strong', '--nds-danger-soft', '--nds-text-2']))
    const unsafe = [...banner].filter((t) => flipsInDark.has(t) && !fleetPin.has(t) && !pagePin.has(t))
    expect(unsafe).toEqual([])
  })

  // The old cards' edges left with the cards (clean-up F, 2026-10-05); a row's error in the grid reads the same token.
  it('a row\'s error in the grid is dark-safe on the Approvals page', () => {
    const grid = stripComments(read(join(FLEET, 'approvals', 'grid', 'approvalsGrid.css')))
    const used = tokensIn(rulesFor(grid, /\.aqg-error\b/))
    expect(used.has('--nds-danger-strong')).toBe(true)
    const unsafe = [...used].filter((t) => flipsInDark.has(t) && !fleetPin.has(t) && !pagePin.has(t))
    expect(unsafe).toEqual([])
  })
})
