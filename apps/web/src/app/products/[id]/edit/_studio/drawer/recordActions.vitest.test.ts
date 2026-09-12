/**
 * PES.4.9 — the drawer adapter's contract with the action registry.
 *
 * The adapter itself is a React component and `apps/web` has no jsdom, so this tests the DECISIONS
 * it delegates rather than its markup — which is the right split anyway: every one of these rules
 * belongs to the registry, and the value of the test is proving the drawer asks instead of
 * inventing. If any of these flipped, the drawer would still render buttons and still look correct.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Source with comments STRIPPED.
 *
 * Written the naive way first, and it failed immediately — on this lane's own doc block, which
 * explains at length why `validateImpact` is no longer called here. A grep that counts a comment
 * as code is `reference_ds_guard_greps_comments`, the exact trap this lane flagged in the parity
 * audit two hours earlier (4.17, where a DEAD? claim hinged on one). Worth the six lines: a
 * source-scanning assertion that reads prose is a guard that fires on its own documentation.
 */
function codeOf(file: string): string {
  return readFileSync(join(__dirname, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

import {
  actionsFor,
  isRunnable,
  ROW,
  SELECTION,
  AVAILABLE,
  HIDDEN,
  disabled,
  type GridAction,
} from '@/design-system/grid/actions/registry'

const verb = (over: Partial<GridAction<{ id: string }>> = {}): GridAction<{ id: string }> => ({
  id: 'pause',
  label: 'Pause offer',
  scope: ROW,
  available: () => AVAILABLE,
  run: async () => ({ ok: true }),
  ...over,
})

describe('what the drawer offers', () => {
  it('keeps a DISABLED verb, with its reason — a vanished verb teaches nothing', () => {
    const offered = actionsFor([verb({ available: () => disabled('Master is not a channel') })], ROW, [{ id: 'r' }])
    expect(offered).toHaveLength(1)
    expect(offered[0].availability).toEqual({ kind: 'disabled', reason: 'Master is not a channel' })
    // …and the drawer must render it unrunnable rather than clickable.
    expect(isRunnable(offered[0].availability)).toBe(false)
  })

  it('drops a HIDDEN verb entirely', () => {
    expect(actionsFor([verb({ available: () => HIDDEN })], ROW, [{ id: 'r' }])).toHaveLength(0)
  })

  it('never offers another surface’s scope — the drawer asks for ROW', () => {
    // A selection verb reaching a single-record surface would act on a selection the drawer
    // cannot see.
    expect(actionsFor([verb({ scope: SELECTION })], ROW, [{ id: 'r' }])).toHaveLength(0)
  })
})

describe('🔴 the sequence is NOT reimplemented here (#124)', () => {
  it('the adapter delegates to runAction rather than hand-writing preflight → confirm → run', () => {
    const src = codeOf('RecordActions.tsx')
    // The point of the ruling: `validateImpact` only protects a surface that remembers to call it,
    // so a second copy is where a type-to-confirm quietly softens into a click. This asserts the
    // copy is GONE, not merely that the substrate exists.
    expect(src).toMatch(/useActionPress/)
    for (const reimplemented of ['validateImpact', 'requiresTypedConfirm', 'action.preflight', 'action.run(']) {
      expect(src, `RecordActions re-derives ${reimplemented} instead of delegating`).not.toContain(reimplemented)
    }
  })

  it('and does not carry its own confirm — one voice for the dangerous verb and the gentle one', () => {
    const src = codeOf('RecordActions.tsx')
    expect(src).not.toContain('DrawerConfirm')
    expect(src).toMatch(/confirmElement/)
  })
})

describe('🔴 the slide-over cannot hide the confirmation it raises', () => {
  const css = () =>
    readFileSync(
      join(__dirname, '..', '..', '..', '..', '..', '..', 'design-system', 'styles', 'components.css'),
      'utf8',
    )

  /** The base `.nds-drawer-dock` rule — where the layer now lives (layout-v2 §5.1). */
  function panelRule(): string {
    const src = css()
    const at = src.indexOf('.nds-drawer-dock {')
    if (at === -1) throw new Error('.nds-drawer-dock is not in components.css — renamed or removed?')
    const end = src.indexOf('}', at)
    if (end === -1) throw new Error('unterminated .nds-drawer-dock rule')
    return src.slice(at, end)
  }

  it('sits at rail level, BELOW the overlay the shared confirm portals to', () => {
    // 1400 (`--nds-z-overlay`, ActionConfirm's backdrop) vs 1410 (`--nds-z-drawer`). Above 1400 and
    // every registry confirmation opens behind the panel that raised it — which this file has
    // already done once, in a media query, and which layout-v2 §5.1 chose non-modal specifically to
    // make structurally impossible. This is that choice, pinned.
    const rule = panelRule()
    expect(rule).toContain('z-index: var(--nds-z-rail)')
    expect(rule).not.toContain('--nds-z-drawer')
    expect(rule).not.toContain('--nds-z-modal')
  })

  it('is non-modal: no backdrop rule was added alongside it', () => {
    // A backdrop that does not block input is a lie about interactivity (§5.2); one that DOES block
    // input would silently make the sheet inert, which is the decision §5.1 rejected.
    expect(css()).not.toContain('.nds-drawer-dock-bd')
  })

  it('the tokens still order the way the argument assumes', () => {
    // The reasoning above is only sound while overlay < drawer. If a future token change inverted
    // them, the rule above would pass while the bug returned.
    const tokens = readFileSync(
      join(__dirname, '..', '..', '..', '..', '..', '..', 'design-system', 'styles', 'tokens.css'),
      'utf8',
    )
    const val = (name: string) => Number(new RegExp(`--nds-z-${name}:\\s*(\\d+)`).exec(tokens)?.[1])
    expect(val('rail')).toBeLessThan(val('overlay'))
    expect(val('overlay')).toBeLessThan(val('drawer'))
  })
})
