import { describe, expect, it } from 'vitest'
import { DESIGN_SCREENS, designScreens, findCase, findScreen } from './_registry'

describe('the design index finds the fixtures by itself (PLAN §3.1)', () => {
  it('lists the W0 shell screens by SCR id', () => {
    expect(DESIGN_SCREENS.map((screen) => screen.screen)).toEqual(['SCR-002', 'SCR-003', 'SCR-004', 'SCR-028'])
    expect(findScreen('SCR-003')?.file).toBe('shell/office/fixtures.ts')
  })

  it('every screen has a view and unique case ids', () => {
    for (const screen of DESIGN_SCREENS) {
      expect(typeof screen.view).toBe('function')
      expect(screen.cases.length).toBeGreaterThan(0)
      expect(new Set(screen.cases.map((item) => item.id)).size).toBe(screen.cases.length)
    }
    expect(findCase(findScreen('SCR-028')!, 'wrong-person')?.label).toBe('Wrong person')
  })

  it('skips a file named fixtures.ts that exports no design screen', () => {
    expect(designScreens({ './a/fixtures.ts': undefined })).toEqual([])
  })
})
