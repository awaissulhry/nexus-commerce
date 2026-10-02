import { describe, expect, it } from 'vitest'
import { validateImpact } from '@/design-system/grid/actions/registry'
import { currentSwitch, effectiveSwitch, leverControlLines, raiseImpact, switchMove, switchOptions, type LeverControl } from './lever-control'

const env = { mode: 'AUTO' as const, reason: 'Armed and writing to Amazon' }

describe('R16 — the lever drawer says what the env allows AND what this business set', () => {
  it('a switch set lower than the env: both, who and when, and what is in force', () => {
    const control: LeverControl = { env, switch: { mode: 'OFF', setBy: 'user:u1', setAt: '2026-10-02T09:00:00.000Z', reason: 'turned down from AUTO' }, switchable: true, levels: ['OFF', 'AUTO'], ceiling: 'AUTO' }
    expect(leverControlLines(control, 'OFF')).toEqual([
      { label: 'Server env allows', value: 'Auto', hint: 'Armed and writing to Amazon' },
      { label: 'This business set', value: 'Off', hint: 'By a person on 02 Oct 2026 — turned down from AUTO. Turning it up waits for a person, and never past the env.' },
      { label: 'In force', value: 'Off', hint: 'The lower of the two, under the account dial.' },
    ])
  })

  it('no switch row: the env alone decides; an engine with no switch says so', () => {
    expect(leverControlLines({ env, switch: null, switchable: true, levels: ['OFF', 'AUTO'], ceiling: 'AUTO' }, 'AUTO')[1]).toEqual({ label: 'This business set', value: 'Not set', hint: 'The env alone decides. Turning it down is instant; turning it up waits for a person.' })
    expect(leverControlLines({ env: { mode: 'OBSERVE', reason: 'Read-only' }, switch: null, switchable: false, levels: [], ceiling: null }, 'OBSERVE')[1]).toEqual({ label: 'This business', value: 'No switch of its own', hint: 'Only the server env switches this engine.' })
  })

  it('an older API without the field: nothing is claimed', () => {
    expect(leverControlLines(undefined, 'AUTO')).toEqual([])
  })
})

describe('R16 — the switch a person moves in the drawer', () => {
  const control: LeverControl = { env: { mode: 'AUTO', reason: 'Armed' }, switch: null, switchable: true, levels: ['OFF', 'OBSERVE', 'AUTO'], ceiling: 'OBSERVE' }

  it('offers its own levels, never one above what the env allows; shows the level IN FORCE and why', () => {
    expect(switchOptions(control)).toEqual([
      { value: 'OFF', label: 'Off', disabled: false },
      { value: 'OBSERVE', label: 'Observe — the server setting allows at most Observe', disabled: false },
      { value: 'AUTO', label: 'Auto — above what the server setting allows', disabled: true },
    ])
    // No row: the switch is open (its top level), but what is in force is the env's Observe — and that is what shows.
    expect(currentSwitch(control)).toBe('AUTO')
    expect(effectiveSwitch(control)).toBe('OBSERVE')
    const set = { ...control, switch: { mode: 'OFF' as const, setBy: 'user:u1', setAt: '2026-10-02T09:00:00.000Z', reason: null } }
    expect([currentSwitch(set), effectiveSwitch(set)]).toEqual(['OFF', 'OFF'])
    expect(switchOptions(set)[0]).toEqual({ value: 'OFF', label: 'Off', disabled: false }) // in force by this business's choice
  })

  it('browser check 25096dd4a: no row and the env allowing Off at most shows Off, saying why — never Auto', () => {
    const capped: LeverControl = { env: { mode: 'OFF', reason: 'NEXUS_ENABLE_RANK_DEFEND is not 1' }, switch: null, switchable: true, levels: ['OFF', 'AUTO'], ceiling: 'OFF' }
    expect(effectiveSwitch(capped)).toBe('OFF')
    expect(switchOptions(capped)).toEqual([
      { value: 'OFF', label: 'Off — the server setting allows at most Off', disabled: false },
      { value: 'AUTO', label: 'Auto — above what the server setting allows', disabled: true },
    ])
  })

  it('down is instant; up asks first, with a confirmation the design system accepts', () => {
    expect(switchMove('AUTO', 'OFF')).toBe('down')
    expect(switchMove('OFF', 'OBSERVE')).toBe('up')
    expect(switchMove('OFF', 'OFF')).toBe('same')
    const impact = raiseImpact('Coverage engine', 'OFF', 'OBSERVE')
    expect(impact).toMatchObject({ level: 'confirm', title: 'Turn Coverage engine up to Observe for this business?' })
    expect(validateImpact(impact)).toEqual([])
    expect(impact.consequences?.join(' ')).toContain('from its next run')
  })
})
