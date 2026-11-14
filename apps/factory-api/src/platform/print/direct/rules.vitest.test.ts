import { describe, expect, it } from 'vitest'
import { directRelayId, isDirectAddress, modeProblem, stationFailure } from './rules'

describe('direct thermal printing (LOG-026)', () => {
  it("takes an address the station's browser reaches: a host or IPv4 with a port, or an http(s) address", () => {
    for (const address of ['192.168.1.50', '192.168.1.50:9100', 'zebra-pack-01.local', 'https://printer.local', 'http://10.0.0.21/pstprnt']) expect(isDirectAddress(address)).toBe(true)
    for (const address of ['zebra queue 1', 'user:secret@10.0.0.21', '', 'ftp://10.0.0.21', '-bad-.local']) expect(isDirectAddress(address)).toBe(false)
  })

  it('lets only a label printer with an address print straight from the station', () => {
    expect(modeProblem({ kind: 'A4_PDF', relayTarget: '10.0.0.5' }, 'DIRECT')).toContain('Only a label printer (ZPL)')
    expect(modeProblem({ kind: 'LABEL_ZPL', relayTarget: 'zebra queue 1' }, 'DIRECT')).toContain("Say the printer's address")
    expect(modeProblem({ kind: 'LABEL_ZPL', relayTarget: '10.0.0.5' }, 'DIRECT')).toBeNull()
    expect(modeProblem({ kind: 'A4_PDF', relayTarget: 'office' }, 'PDF')).toBeNull()
  })

  it("names the station that holds a job, and keeps the station's words on one line of at most 300 characters", () => {
    expect(directRelayId({ deviceId: 'dev-1', actorId: 'worker-1' })).toBe('direct:dev-1')
    expect(directRelayId({ deviceId: null, actorId: 'user-1' })).toBe('direct:user-1')
    expect(stationFailure(undefined)).toBe('The station could not print it: the printer did not answer.')
    expect(stationFailure('out of\nlabels')).toBe('The station could not print it: out of labels')
    expect(stationFailure('x'.repeat(400))).toHaveLength(300)
  })
})
