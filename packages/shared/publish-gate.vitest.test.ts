import { expect, it } from 'vitest'
import { gateNote } from './publish-gate.js'

it('only live earns silence; every unknown and contained mode explains its reach', () => {
  expect(gateNote('live', 'Amazon')).toBeNull()
  expect(gateNote('gated', 'Amazon')).toContain('publishing is switched off')
  expect(gateNote('dry-run', 'Amazon')).toContain('without touching the real listing')
  expect(gateNote('sandbox', 'Amazon')).toContain('never on the live listing')
  expect(gateNote(null, 'Amazon')).toContain('not described by this server response')
  expect(gateNote('new-mode', 'Amazon')).toContain('unrecognised publish mode (new-mode)')
})
