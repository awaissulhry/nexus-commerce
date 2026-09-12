import { describe, expect, it } from 'vitest'
import { isCellCovered, revealDistance } from './revealCell'

const cases = [
  { name: 'PES.4 #257 fabric_type (76px overlap)', cellRight: 1267, viewportRight: 1728, panelOverlap: 520, margin: 16 },
  { name: 'UX.1 witness name@1280 (76px overlap)', cellRight: 836, viewportRight: 1280, panelOverlap: 520, margin: 16 },
  { name: 'AG.1 passing gpsr (189px overlap)', cellRight: 1381, viewportRight: 1728, panelOverlap: 520, margin: 16 },
]

describe('#261 probe', () => {
  for (const c of cases) {
    it(`${c.name} -> threshold=${c.viewportRight - c.panelOverlap - c.margin} covered=${isCellCovered(c)} distance=${revealDistance(c, 'uncover')}`, () => {
      expect(true).toBe(true)
    })
  }
})
