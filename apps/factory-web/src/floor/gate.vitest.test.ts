import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { leaveSignIn } from './gate'

/**
 * W1-BGF (the W1 browser stages' repair) — the welcome cards end with a move to Home. On a slow server FloorMoves takes a move back
 * when `/floor/version` does not answer in 1.5 s (the frame says the page opens when the network is back); the gate ran again only
 * on a new address, and the address had not changed: a signed-in worker stayed on the badge screen (the browser golden flow's
 * warehouse worker, on a loaded machine). The gate now runs again when the held move's words go, and tries once more.
 */

const BASE = { noticeDue: false, arriving: false, pendingSwitch: false, crewStep: false, moveHeld: false, arrivalTo: null, landing: '/floor', notice: '/floor/notice' }

describe('the gate on the sign-in page, for a signed-in person', () => {
  it('the notice first; the welcome cards while they run; then where they ended, else the landing', () => {
    expect(leaveSignIn({ ...BASE, noticeDue: true, arriving: true })).toBe('/floor/notice')
    expect(leaveSignIn({ ...BASE, arriving: true })).toBeNull()
    expect(leaveSignIn(BASE)).toBe('/floor')
    expect(leaveSignIn({ ...BASE, arrivalTo: '/floor/operation' })).toBe('/floor/operation')
    expect(leaveSignIn({ ...BASE, landing: '/floor/lineview' })).toBe('/floor/lineview')
  })

  it('a switch or a crew step in progress stays on sign-in', () => {
    expect(leaveSignIn({ ...BASE, pendingSwitch: true, noticeDue: true })).toBeNull()
    expect(leaveSignIn({ ...BASE, crewStep: true })).toBeNull()
  })

  it('a move taken back waits while its words show, then goes again', () => {
    expect(leaveSignIn({ ...BASE, moveHeld: true })).toBeNull()
    expect(leaveSignIn({ ...BASE, moveHeld: false })).toBe('/floor')
    const app = readFileSync(new URL('./FloorApp.tsx', import.meta.url), 'utf8')
    expect(app).toMatch(/const next = leaveSignIn\(\{[\s\S]*?moveHeld,[\s\S]*?\}\)\s*if \(next\) router\.replace\(next\)/)
    expect(app).toMatch(/\[load\.status, device, me, pathname, pendingSwitch, crewStep, arriving, moveHeld, router\]\)/)
  })
})
