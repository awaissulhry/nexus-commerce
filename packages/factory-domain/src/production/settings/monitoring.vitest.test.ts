import { describe, expect, it } from 'vitest'
import { EVENT_CATALOGUE } from '../../events/catalogue'
import { FACTORY_PERMISSIONS } from '../../auth/permissions/catalogue'
import { ROLE_TEMPLATES } from '../../auth/roles/templates'
import {
  changeNeedsReason,
  changeNeedsStepUp,
  floorRecordSubject,
  floorRulesStatus,
  legalBasisProblems,
  monitoringChangeOf,
  monitoringImpact,
  REFERENCE_MAX,
  scanSubjectChangeProblems,
  scanSubjectOf,
} from './monitoring'
import { PRODUCTION_SETTINGS_MANAGE, PRODUCTION_SETTINGS_VIEW } from './permissions'

/**
 * The monitoring switch's rules (B-W1-37; MES-278, PLT-208; Statuto dei Lavoratori, L. 300/1970, art. 4): naming workers
 * needs a legal basis on record; widening asks for a step-up and a reason, narrowing never asks; a change applies from
 * now on; a floor record names a worker only after the notice, and at a STATION site only the station.
 */

const NONE_AFFECTED = { openWorkOrders: 0, workersActive: 0, workersNotAcknowledged: 0, devicesWithoutStation: 0 }

describe('the switch', () => {
  it('a site without floor rules names the worker (the schema default)', () => {
    expect(scanSubjectOf(null)).toBe('WORKER')
    expect(scanSubjectOf({ scanSubject: 'STATION' })).toBe('STATION')
  })

  it('widening is STATION → WORKER and asks for a step-up and a reason; narrowing asks for neither', () => {
    expect(monitoringChangeOf('STATION', 'WORKER')).toBe('WIDEN')
    expect(monitoringChangeOf('WORKER', 'STATION')).toBe('NARROW')
    expect(monitoringChangeOf('WORKER', 'WORKER')).toBe('NONE')
    expect([changeNeedsStepUp('WIDEN'), changeNeedsStepUp('NARROW'), changeNeedsStepUp('NONE')]).toEqual([true, false, false])
    expect([changeNeedsReason('WIDEN'), changeNeedsReason('NARROW'), changeNeedsReason('NONE')]).toEqual([true, false, false])
  })

  it('naming workers needs a legal basis on record, also on a site that names them by default', () => {
    const widen = scanSubjectChangeProblems({ from: 'STATION', to: 'WORKER', basisOnRecord: false, reason: 'Agreement signed.' })
    expect(widen).toEqual([{ path: 'body/legalBasis', message: expect.stringMatching(/^Record the legal basis for naming workers first \(L\. 300\/1970 art\. 4 c\.1\)/) }])
    expect(scanSubjectChangeProblems({ from: 'WORKER', to: 'WORKER', basisOnRecord: false })).toHaveLength(1)
    expect(scanSubjectChangeProblems({ from: 'STATION', to: 'WORKER', basisOnRecord: true, reason: 'Agreement signed.' })).toEqual([])
  })

  it('widening says why; narrowing never has to, and never needs a basis', () => {
    expect(scanSubjectChangeProblems({ from: 'STATION', to: 'WORKER', basisOnRecord: true, reason: '  ' })).toEqual([
      { path: 'body/reason', message: 'Say why floor records will name workers from now on.' },
    ])
    expect(scanSubjectChangeProblems({ from: 'WORKER', to: 'STATION', basisOnRecord: false })).toEqual([])
    expect(scanSubjectChangeProblems({ from: 'WORKER', to: 'STATION', basisOnRecord: false, reason: 'x'.repeat(501) })).toEqual([{ path: 'body/reason', message: 'Keep the reason to 500 characters.' }])
  })

  it('a legal basis is a known kind with a reference', () => {
    expect(legalBasisProblems({ kind: 'UNION_AGREEMENT', reference: 'RSU agreement of 3 March 2027' })).toEqual([])
    expect(legalBasisProblems({ kind: 'A_HANDSHAKE', reference: ' ' }).map((issue) => issue.path)).toEqual(['body/kind', 'body/reference'])
    expect(legalBasisProblems({ kind: 'NOT_REQUIRED', reference: 'x'.repeat(REFERENCE_MAX + 1) }).map((issue) => issue.path)).toEqual(['body/reference'])
    expect(legalBasisProblems(null, 'body/legalBasis')).toEqual([{ path: 'body/legalBasis', message: expect.stringContaining('art. 4 c.1') }])
  })
})

describe('what a change reaches', () => {
  const affected = { openWorkOrders: 3, workersActive: 36, workersNotAcknowledged: 2, devicesWithoutStation: 1 }

  it('says what narrowing means, and that past records keep what they recorded', () => {
    expect(monitoringImpact('WORKER', 'STATION', affected)).toEqual([
      'From now on scans and cut logs at this site name the station only, never the worker. 3 open work orders go on that way.',
      '1 floor device has no station: give each one a station (Admin › Devices), or it records nothing.',
      'Records already made keep what they recorded: scans and cut logs are never changed.',
    ])
  })

  it('says what widening means, with the count of workers who must acknowledge the notice first (a count, no names)', () => {
    expect(monitoringImpact('STATION', 'WORKER', affected)).toEqual([
      'From now on scans and cut logs at this site name the signed-in worker. 3 open work orders go on that way.',
      '2 of 36 active workers have not acknowledged the information notice: no scan or cut log names them until they do (L. 300/1970 art. 4 c.3; GDPR art. 13).',
      'Records already made keep what they recorded: scans and cut logs are never changed.',
    ])
    expect(monitoringImpact('STATION', 'STATION', affected)).toEqual([])
    expect(monitoringImpact('STATION', 'WORKER', NONE_AFFECTED)).toHaveLength(2)
  })

  it('real floor work waits for the basis or the choice of STATION (Q16)', () => {
    expect(floorRulesStatus({ scanSubject: 'WORKER', basisOnRecord: false })).toEqual({ readyForFloor: false, notes: [expect.stringMatching(/no legal basis is on record/)] })
    expect(floorRulesStatus({ scanSubject: 'STATION', basisOnRecord: false }).readyForFloor).toBe(true)
    expect(floorRulesStatus({ scanSubject: 'WORKER', basisOnRecord: true, workersActive: 36, workersNotAcknowledged: 2 })).toEqual({
      readyForFloor: true,
      notes: ['Scans and cut logs name the signed-in worker.', '2 of 36 active workers have not acknowledged the information notice: they cannot scan or log cuts by name until they do.'],
    })
  })
})

describe('the subject of a floor record', () => {
  it('a STATION site names the device station and no worker; a device without a station records nothing', () => {
    expect(floorRecordSubject({ scanSubject: 'STATION', workerId: 'w', workerAcknowledged: true, stationId: 's' })).toEqual({ ok: true, workerId: null, stationId: 's' })
    expect(floorRecordSubject({ scanSubject: 'STATION', workerId: 'w', workerAcknowledged: true, stationId: null })).toMatchObject({ ok: false, message: expect.stringMatching(/no station/) })
  })

  it('a WORKER site names the signed-in worker, only after the notice', () => {
    expect(floorRecordSubject({ scanSubject: 'WORKER', workerId: 'w', workerAcknowledged: true, stationId: undefined })).toEqual({ ok: true, workerId: 'w', stationId: null })
    expect(floorRecordSubject({ scanSubject: 'WORKER', workerId: 'w', workerAcknowledged: false, stationId: 's' })).toMatchObject({ ok: false, message: expect.stringMatching(/acknowledge the information notice/) })
    expect(floorRecordSubject({ scanSubject: 'WORKER', workerId: null, workerAcknowledged: false, stationId: 's' })).toMatchObject({ ok: false, message: expect.stringMatching(/^Sign in first/) })
  })
})

describe('declared', () => {
  it('the permissions are in the registry; the production manager changes the switch, the floor never holds it', () => {
    expect(FACTORY_PERMISSIONS.get(PRODUCTION_SETTINGS_VIEW)).toMatchObject({ area: 'production', risk: 'read' })
    expect(FACTORY_PERMISSIONS.get(PRODUCTION_SETTINGS_MANAGE)).toMatchObject({ area: 'production', risk: 'write' })
    const holders = (permission: string) => ROLE_TEMPLATES.filter((template) => template.permissions.includes(permission as never)).map((template) => template.key)
    expect(holders(PRODUCTION_SETTINGS_MANAGE)).toEqual(['owner', 'production_manager'])
    expect(holders(PRODUCTION_SETTINGS_VIEW)).toEqual(['owner', 'admin', 'production_manager', 'floor_supervisor', 'read_only'])
  })

  it('production.monitoring_changed carries no basis text, reason or name', () => {
    const payload = { siteId: '0195f0a0-0000-7000-8000-000000000001', scanSubject: 'STATION', previous: 'WORKER', change: 'NARROWED', basisOnRecord: true }
    expect(EVENT_CATALOGUE.parse('production.monitoring_changed', 1, payload)).toEqual(payload)
    expect(() => EVENT_CATALOGUE.parse('production.monitoring_changed', 1, { ...payload, reference: 'RSU 2027' })).toThrow(/reference/)
  })
})
