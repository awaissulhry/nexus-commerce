import { describe, expect, it } from 'vitest'

import {
  MODE_STEPS, compareModes, isModeHeld, modeBars, modeCellKey, modeCellText, modeHeldSentence, modeIndex, modeOptions,
  modeWord, readMode, suppressModeKeys,
} from './modeModel'

describe('modeModel — the four steps and what holds a row lower', () => {
  it('reads a plain step and the { set, acts, heldBy } shape; nothing is never Off', () => {
    expect(readMode('ASK')).toEqual({ set: 'ASK', acts: 'ASK', heldBy: null })
    expect(readMode({ set: 'AUTO', acts: 'ASK', heldBy: { kind: 'dial', label: 'the account dial' } }))
      .toEqual({ set: 'AUTO', acts: 'ASK', heldBy: { kind: 'dial', label: 'the account dial' } })
    expect(readMode({ set: 'WATCH' })).toEqual({ set: 'WATCH', acts: 'WATCH', heldBy: null })
    expect(readMode(null)).toEqual({ set: null, acts: null, heldBy: null })
    expect(readMode('')).toEqual({ set: null, acts: null, heldBy: null })
    expect(modeWord(MODE_STEPS, readMode(null).set)).toBe('')
  })

  it('names each step in the Owner\'s words, and shows an unknown stored value as it is', () => {
    expect(MODE_STEPS.map((s) => s.label)).toEqual(['Off', 'Watch', 'Ask me', 'Auto'])
    expect(modeWord(MODE_STEPS, 'ASK')).toBe('Ask me')
    expect(modeWord(MODE_STEPS, 'PROPOSE')).toBe('PROPOSE')
    expect(modeIndex(MODE_STEPS, 'AUTO')).toBe(3)
    expect(modeIndex(MODE_STEPS, 'PROPOSE')).toBe(-1)
  })

  it('is held only when what acts is LOWER than what is set', () => {
    const held = readMode({ set: 'AUTO', acts: 'ASK', heldBy: { label: 'the account dial' } })
    expect(isModeHeld(MODE_STEPS, held)).toBe(true)
    expect(modeHeldSentence(MODE_STEPS, held)).toBe('Acts as Ask me: held by the account dial')
    expect(modeHeldSentence(MODE_STEPS, readMode({ set: 'AUTO', acts: 'OFF' }))).toBe('Acts as Off')
    // Same step, or acting HIGHER (never expected, never drawn as held), or an unknown step: no mark.
    expect(isModeHeld(MODE_STEPS, readMode({ set: 'ASK', acts: 'ASK', heldBy: { label: 'x' } }))).toBe(false)
    expect(isModeHeld(MODE_STEPS, readMode({ set: 'WATCH', acts: 'AUTO' }))).toBe(false)
    expect(isModeHeld(MODE_STEPS, readMode({ set: 'AUTO', acts: 'PROPOSE' }))).toBe(false)
  })

  it('draws one bar per step above Off: on up to what acts, held up to what is set', () => {
    expect(modeBars(MODE_STEPS, readMode('OFF'))).toEqual(['off', 'off', 'off'])
    expect(modeBars(MODE_STEPS, readMode('ASK'))).toEqual(['on', 'on', 'off'])
    expect(modeBars(MODE_STEPS, readMode('AUTO'))).toEqual(['on', 'on', 'on'])
    expect(modeBars(MODE_STEPS, readMode({ set: 'AUTO', acts: 'WATCH' }))).toEqual(['on', 'held', 'held'])
    expect(modeBars(MODE_STEPS, readMode({ set: 'AUTO', acts: 'OFF' }))).toEqual(['held', 'held', 'held'])
    expect(modeBars(MODE_STEPS, readMode(null))).toEqual(['off', 'off', 'off'])
  })

  it('says the cell in one line: the set step, what holds it, a lock', () => {
    expect(modeCellText(MODE_STEPS, readMode('ASK'))).toBe('Ask me')
    expect(modeCellText(MODE_STEPS, readMode({ set: 'AUTO', acts: 'ASK', heldBy: { label: 'the account dial' } })))
      .toBe('Auto · acts as Ask me: held by the account dial')
    expect(modeCellText(MODE_STEPS, readMode('WATCH'), 'Needs the ads permission')).toBe('Watch · locked: Needs the ads permission')
    expect(modeCellText(MODE_STEPS, readMode(null))).toBe('Not set')
  })

  it('lists every step in order; a step the row cannot take is held with its reason as the visible line', () => {
    const reading = readMode({ set: 'AUTO', acts: 'ASK', heldBy: { label: 'the account dial' } })
    const options = modeOptions(MODE_STEPS, reading, (step) => (step === 'AUTO' ? 'Needs 14 clean days first' : null))
    expect(options.map((o) => o.value)).toEqual(['OFF', 'WATCH', 'ASK', 'AUTO'])
    expect(options[3]).toEqual({ value: 'AUTO', label: 'Auto', heldReason: 'Needs 14 clean days first', note: 'Needs 14 clean days first' })
    expect(options[2]).toEqual({ value: 'ASK', label: 'Ask me' })
    // The set step that does not act says so, when it is not itself held.
    expect(modeOptions(MODE_STEPS, reading)[3]).toEqual({ value: 'AUTO', label: 'Auto', note: 'Acts as Ask me: held by the account dial' })
  })

  it('sorts by the scale, unknown last', () => {
    const sorted = ['AUTO', 'PROPOSE', 'OFF', 'ASK', 'WATCH'].sort((a, b) => compareModes(MODE_STEPS, a, b))
    expect(sorted).toEqual(['OFF', 'WATCH', 'ASK', 'AUTO', 'PROPOSE'])
  })
})

describe('modeModel — keys', () => {
  const cell = { id: 'cell' }
  it('keeps Space from AG (it would tick the row), leaves Enter, arrows and Tab to AG, and nothing while editing', () => {
    expect(suppressModeKeys({ event: { key: ' ' } })).toBe(true)
    expect(suppressModeKeys({ event: { key: 'Spacebar' } })).toBe(true)
    expect(suppressModeKeys({ event: { key: 'Enter' } })).toBe(false)
    expect(suppressModeKeys({ event: { key: 'ArrowDown' } })).toBe(false)
    expect(suppressModeKeys({ event: { key: ' ', ctrlKey: true } })).toBe(false)
    expect(suppressModeKeys({ event: { key: ' ' }, editing: true })).toBe(false)
  })

  it('opens the list on Space ON the cell; a locked cell answers Space and Enter by showing why', () => {
    expect(modeCellKey({ key: ' ', target: cell }, cell, false)).toBe('open')
    expect(modeCellKey({ key: 'Enter', target: cell }, cell, false)).toBe(null)
    expect(modeCellKey({ key: ' ', target: cell }, cell, true)).toBe('explain')
    expect(modeCellKey({ key: 'Enter', target: cell }, cell, true)).toBe('explain')
    expect(modeCellKey({ key: ' ', target: { id: 'inner' } }, cell, false)).toBe(null)
    expect(modeCellKey({ key: ' ', target: cell, repeat: true }, cell, false)).toBe(null)
    expect(modeCellKey({ key: ' ', target: cell, metaKey: true }, cell, false)).toBe(null)
  })
})
