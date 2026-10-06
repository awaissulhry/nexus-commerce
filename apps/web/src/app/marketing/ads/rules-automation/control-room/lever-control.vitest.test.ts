import { describe, expect, it } from 'vitest'
import { canConfirmAction } from '@/design-system/components/ActionConfirm'
import { validateImpact } from '@/design-system/grid/actions/registry'
import {
  currentSwitch, effectiveSwitch, leverControlLines, lowerImpact, raiseImpact, runNowImpact, switchMove, switchOptions, switchStep,
  type LeverControl,
} from './lever-control'

const env = { mode: 'AUTO' as const, reason: 'Armed and writing to Amazon' }

describe('R16 — the engine drawer says what the server allows AND what this business set, in plain words', () => {
  it('a switch set lower than the server: both, who and when, and what is in force', () => {
    const control: LeverControl = { env, switch: { mode: 'OFF', setBy: 'user:u1', setAt: '2026-10-02T09:00:00.000Z', reason: 'turned down from AUTO' }, switchable: true, levels: ['OFF', 'AUTO'], ceiling: 'AUTO' }
    expect(leverControlLines(control)).toEqual([
      { label: 'The server allows', value: 'Auto', hint: 'Set on the server. Only a deploy changes it.' },
      { label: 'This business set', value: 'Off', hint: 'By a person on 02 Oct 2026 — turned down from AUTO. Never above the server setting.' },
    ])
  })

  it('no switch row: the server alone decides; an engine with no switch says so', () => {
    expect(leverControlLines({ env, switch: null, switchable: true, levels: ['OFF', 'AUTO'], ceiling: 'AUTO' })[1]).toEqual({ label: 'This business set', value: 'Not set', hint: 'The server’s level applies.' })
    expect(leverControlLines({ env: { mode: 'OBSERVE', reason: 'Read-only' }, switch: null, switchable: false, levels: [], ceiling: null })[1]).toEqual({ label: 'This business', value: 'No level of its own', hint: 'Only the server decides this engine.' })
  })

  it('CR rebuild 2: the lines never show a server variable name (those stay under Technical details)', () => {
    const lines = leverControlLines({ env: { mode: 'OFF', reason: 'NEXUS_ENABLE_RANK_DEFEND is not 1' }, switch: null, switchable: true, levels: ['OFF', 'AUTO'], ceiling: 'OFF' })
    expect(JSON.stringify(lines)).not.toMatch(/NEXUS_/)
  })

  it('an older API without the field: nothing is claimed', () => {
    expect(leverControlLines(undefined)).toEqual([])
  })
})

describe('R16 — the switch a person moves in the drawer', () => {
  const control: LeverControl = { env: { mode: 'AUTO', reason: 'Armed' }, switch: null, switchable: true, levels: ['OFF', 'OBSERVE', 'AUTO'], ceiling: 'OBSERVE' }

  it('offers its own levels in the one scale, never one above what the server allows; shows the level IN FORCE and why', () => {
    expect(switchOptions(control)).toEqual([
      { value: 'OFF', label: 'Off', disabled: false },
      { value: 'OBSERVE', label: 'Watch — the server setting allows at most Watch', disabled: false },
      { value: 'AUTO', label: 'Auto — above what the server setting allows', disabled: true },
    ])
    // No row: the switch is open (its top level), but what is in force is the server's Watch — and that is what shows.
    expect(currentSwitch(control)).toBe('AUTO')
    expect(effectiveSwitch(control)).toBe('OBSERVE')
    const set = { ...control, switch: { mode: 'OFF' as const, setBy: 'user:u1', setAt: '2026-10-02T09:00:00.000Z', reason: null } }
    expect([currentSwitch(set), effectiveSwitch(set)]).toEqual(['OFF', 'OFF'])
    expect(switchOptions(set)[0]).toEqual({ value: 'OFF', label: 'Off', disabled: false }) // in force by this business's choice
  })

  it('browser check 25096dd4a: no row and the server allowing Off at most shows Off, saying why — never Auto', () => {
    const capped: LeverControl = { env: { mode: 'OFF', reason: 'NEXUS_ENABLE_RANK_DEFEND is not 1' }, switch: null, switchable: true, levels: ['OFF', 'AUTO'], ceiling: 'OFF' }
    expect(effectiveSwitch(capped)).toBe('OFF')
    expect(switchOptions(capped)).toEqual([
      { value: 'OFF', label: 'Off — the server setting allows at most Off', disabled: false },
      { value: 'AUTO', label: 'Auto — above what the server setting allows', disabled: true },
    ])
  })

  it('which way a move goes', () => {
    expect(switchMove('AUTO', 'OFF')).toBe('down')
    expect(switchMove('OFF', 'OBSERVE')).toBe('up')
    expect(switchMove('OFF', 'OFF')).toBe('same')
  })

  it('up to Auto asks with the tick; up to Watch changes nothing by itself, so it is a plain question', () => {
    const auto = raiseImpact('Coverage engine', 'OFF', 'AUTO')
    expect(auto).toMatchObject({ level: 'confirm', title: 'Raise Coverage engine to Auto for this business?', confirmLabel: 'Raise to Auto' })
    expect(validateImpact(auto)).toEqual([])
    expect(canConfirmAction(auto, '', false)).toBe(false)
    const watch = raiseImpact('Coverage engine', 'OFF', 'OBSERVE')
    expect(watch).toMatchObject({ title: 'Raise Coverage engine to Watch for this business?', confirmLabel: 'Raise to Watch' })
    expect(validateImpact(watch)).toEqual([])
    expect(watch.consequences?.join(' ')).toContain('from its next run')
    expect(canConfirmAction(watch, '', false)).toBe(true)
  })

  it('THE REGRESSION: down asks too (a brake turned off used to go at once), as a plain question with no tick', () => {
    const impact = lowerImpact('Budget enforcement', 'AUTO', 'OFF')
    expect(impact.title).toBe('Lower Budget enforcement to Off for this business?')
    expect(impact.consequences).toContain('It stops running. Whatever it protects — a budget, a bid floor — is no longer protected by it.')
    expect(validateImpact(impact)).toEqual([])
    expect(canConfirmAction(impact, '', false)).toBe(true)

    const on: LeverControl = { ...control, ceiling: 'AUTO' }
    const chose = switchStep({ pending: null }, { type: 'choose', to: 'OFF', engineName: 'Budget enforcement', control: on })
    expect(chose.send).toBeNull()
    expect(chose.state.pending).toMatchObject({ to: 'OFF', up: false })
    expect(switchStep(chose.state, { type: 'confirm' })).toEqual({ state: { pending: null }, send: { to: 'OFF', confirm: false } })
  })

  it('Run now asks with the tick: it may change the ads at once', () => {
    const impact = runNowImpact('Bid optimiser')
    expect(impact.title).toBe('Run Bid optimiser now?')
    expect(validateImpact(impact)).toEqual([])
    expect(canConfirmAction(impact, '', false)).toBe(false)
    expect(canConfirmAction(impact, '', true)).toBe(true)
  })
})
