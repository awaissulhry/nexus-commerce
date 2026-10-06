/**
 * Browser check on 25096dd4a — the engine drawer's switch, rendered (react-dom/server) and driven by the drawer's own
 * step function. The design system's Drawer portals into a real document, which this node-only config has not
 * (vitest.config.ts), so the test renders exactly the two pieces the drawer puts into it: its switch section (body)
 * and its up-confirmation (the Drawer's `overlay`). JSX is `createElement`, as the config requires.
 *
 *   · the server setting allows a higher level: picking it opens the up-confirmation (an ActionConfirm), which can be
 *     cancelled — nothing sent, the confirmation gone; confirming sends the move with confirm: true; a move down opens a
 *     plain confirmation too (CR rebuild 2);
 *   · the server setting allows Off at most and no switch is set: the switch shows Off and says why; every level
 *     above is listed and disabled.
 */
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { LeverSwitchSection } from './LeverSwitch'
import { LeverConfirm } from './LeverConfirm'
import { switchStep, type LeverControl, type SwitchState } from './lever-control'

const noop = () => {}
const section = (control: LeverControl, canSwitch = true) =>
  renderToStaticMarkup(createElement(LeverSwitchSection, { control, canSwitch, busy: false, onChoose: noop }))
const overlay = (state: SwitchState) =>
  (state.pending ? renderToStaticMarkup(createElement(LeverConfirm, { impact: state.pending.impact, onCancel: noop, onConfirm: noop })) : '')
const optionsOf = (html: string) => [...html.matchAll(/<option([^>]*)>([^<]*)<\/option>/g)].map((m) => ({ text: m[2], selected: /selected=""/.test(m[1]), disabled: /disabled=""/.test(m[1]) }))

describe('the engine drawer switch, rendered', () => {
  it('the server setting allows Auto: picking Auto opens the up-confirmation; Cancel closes it and sends nothing; Confirm sends', () => {
    const control: LeverControl = { env: { mode: 'AUTO', reason: 'Armed' }, switch: { mode: 'OFF', setBy: 'user:u1', setAt: '2026-10-02T09:00:00.000Z', reason: null }, switchable: true, levels: ['OFF', 'AUTO'], ceiling: 'AUTO' }
    expect(optionsOf(section(control))).toEqual([
      { text: 'Off', selected: true, disabled: false },
      { text: 'Auto', selected: false, disabled: false },
    ])
    let state: SwitchState = { pending: null }
    expect(overlay(state)).toBe('')

    const chose = switchStep(state, { type: 'choose', to: 'AUTO', engineName: 'Rank-defend', control })
    expect(chose.send).toBeNull() // up never sends before the confirmation
    state = chose.state
    const confirm = overlay(state)
    expect(confirm).toContain('aria-label="Raise Rank-defend to Auto for this business?"')
    expect(confirm).toContain('At Auto it changes your ads by itself, inside your limits.')
    expect(confirm).toMatch(/<button[^>]*data-autofocus[^>]*>Cancel<\/button>/)
    expect(confirm).toMatch(/<button[^>]*disabled=""[^>]*>Raise to Auto<\/button>/) // armed only once acknowledged; named for its action

    const cancelled = switchStep(state, { type: 'cancel' })
    expect(cancelled).toEqual({ state: { pending: null }, send: null })
    expect(overlay(cancelled.state)).toBe('')

    expect(switchStep(state, { type: 'confirm' })).toEqual({ state: { pending: null }, send: { to: 'AUTO', confirm: true } })
    // CR rebuild 2 — down asks too, with a plain question (Confirm armed at once, no tick).
    const on: LeverControl = { ...control, switch: null }
    const down = switchStep({ pending: null }, { type: 'choose', to: 'OFF', engineName: 'Rank-defend', control: on })
    expect(down.send).toBeNull()
    const ask = overlay(down.state)
    expect(ask).toContain('aria-label="Lower Rank-defend to Off for this business?"')
    expect(ask).toMatch(/<button(?![^>]*disabled="")[^>]*>Lower to Off<\/button>/)
    expect(switchStep(down.state, { type: 'confirm' })).toEqual({ state: { pending: null }, send: { to: 'OFF', confirm: false } })
  })

  it('the server setting allows Off at most and no switch is set: it shows Off, says why, and nothing above can be picked', () => {
    const capped: LeverControl = { env: { mode: 'OFF', reason: 'NEXUS_ENABLE_RANK_DEFEND is not 1' }, switch: null, switchable: true, levels: ['OFF', 'OBSERVE', 'AUTO'], ceiling: 'OFF' }
    const html = section(capped)
    expect(optionsOf(html)).toEqual([
      { text: 'Off — the server setting allows at most Off', selected: true, disabled: false },
      { text: 'Watch — above what the server setting allows', selected: false, disabled: true },
      { text: 'Auto — above what the server setting allows', selected: false, disabled: true },
    ])
    expect(html).not.toMatch(/<option[^>]*selected=""[^>]*>Auto/)
    // Without the permission the switch is shown, disabled, and says why.
    const readOnly = section(capped, false)
    expect(readOnly).toMatch(/<select[^>]*disabled=""/)
    expect(readOnly).toContain('Changing it needs the ads automation permission.')
  })
})
