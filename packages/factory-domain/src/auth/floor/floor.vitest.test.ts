import { describe, expect, it } from 'vitest'
import { assertTransition } from '../../state/machine'
import { heldGrains } from '../grains/grains'
import { FACTORY_PERMISSIONS, FLOOR_SHARED_PERMISSIONS } from '../permissions/catalogue'
import { audienceProblems, ROLE_TEMPLATES, templateOf, templateProblems } from '../roles/templates'
import { roleProblems } from '../roles/roles'
import { badgeCodeHash, badgeHint, newBadgeCode, normalizeBadgeCode, printedBadgeCode } from './badge'
import { floorGrants, FLOOR_GRAINS } from './grants'
import { hashPassword, verifyPassword } from '../password/password'
import { hashPin, isPinLocked, pinKeyring, pinLockMsAfter, pinLockUntil, pinPepper, pinProblems, PIN_LOCKOUT, randomPin, verifyPin } from './pin'
import { FLOOR_SESSION, idleEndAt, sessionEndsAt, sessionState, timingProblems, zonedInstant } from './session'
import { badgeStatus, deviceStatus, workerStatus } from './status'

const NOW = new Date('2026-10-28T09:00:00.000Z')
/** A cheaper scrypt for tests that need several hashes. */
const CHEAP = { logN: 12, r: 8, p: 1 }
const SITE = '019a0000-0000-7000-8000-00000000a001'
const COMPANY = '019a0000-0000-7000-8000-00000000c001'

describe('the PIN policy (PLT-058)', () => {
  it('accepts six digits that are not trivial', () => {
    for (const pin of ['482913', '730561', '905218']) expect(pinProblems(pin)).toEqual([])
  })

  it('refuses anything but exactly six digits', () => {
    for (const pin of ['48291', '4829131', '48a913', ' 482913', '', 482913, null]) expect(pinProblems(pin)[0]?.path).toBe('pin')
  })

  it('refuses repeats, runs, mirrors, well-known PINs and the employee number', () => {
    for (const pin of ['000000', '777777', '121212', '123123', '123456', '654321', '012345', '890123', '987654', '123321', '112233', '159753']) {
      expect(pinProblems(pin), pin).not.toEqual([])
    }
    expect(pinProblems('482913', { employeeCode: 'E-482913' })).not.toEqual([])
    expect(pinProblems('482913', { employeeCode: '7' })).toEqual([])
  })

  it('makes random PINs that pass the policy', () => {
    for (let index = 0; index < 50; index++) expect(pinProblems(randomPin())).toEqual([])
  })
})

describe('PIN storage (pepper, then scrypt)', () => {
  const keyring = pinKeyring('a-made-up-pin-pepper-for-tests-0001')
  const other = pinKeyring('another-made-up-pin-pepper-for-tests-02')

  it('stores the pepper id and a salted scrypt hash of the peppered PIN, never the PIN, and checks it', async () => {
    const stored = await hashPin('482913', keyring)
    expect(stored).toMatch(new RegExp(`^\\$pin\\$${keyring.current.id}\\$\\$scrypt\\$ln=15,r=8,p=3\\$`))
    expect(stored).not.toContain('482913')
    expect(await hashPin('482913', keyring)).not.toBe(stored)
    expect((await verifyPin('482913', stored, keyring)).ok).toBe(true)
    expect((await verifyPin('482914', stored, keyring)).ok).toBe(false)
  }, 20_000)

  it('the same PIN with a different pepper does not match', async () => {
    const stored = await hashPin('482913', keyring, CHEAP)
    expect(other.current.id).not.toBe(keyring.current.id)
    expect((await verifyPin('482913', stored, other)).ok).toBe(false)
    // Even a hash relabelled with the other pepper's id opens nothing.
    expect((await verifyPin('482913', stored.replace(keyring.current.id, other.current.id), other)).ok).toBe(false)
  }, 20_000)

  it('a stored hash is never a pepper-less scrypt of the PIN', async () => {
    const stored = await hashPin('482913', keyring, CHEAP)
    const scryptPart = stored.slice(`$pin$${keyring.current.id}$`.length)
    expect(stored.startsWith('$scrypt$')).toBe(false)
    expect((await verifyPassword('482913', scryptPart)).ok).toBe(false)
    // And a plain scrypt hash of the PIN is not accepted as a stored PIN.
    expect((await verifyPin('482913', await hashPassword('482913', CHEAP), keyring)).ok).toBe(false)
  }, 20_000)

  it('rotates: a previous pepper still opens its hashes and asks for a re-hash with the current one', async () => {
    const stored = await hashPin('482913', keyring, CHEAP)
    const rotated = pinKeyring('another-made-up-pin-pepper-for-tests-02', ['a-made-up-pin-pepper-for-tests-0001'])
    expect(await verifyPin('482913', stored, rotated)).toEqual({ ok: true, needsRehash: true })
    expect((await hashPin('482913', rotated, CHEAP)).startsWith(`$pin$${rotated.current.id}$`)).toBe(true)
    expect(pinPepper('a-made-up-pin-pepper-for-tests-0001').id).toBe(keyring.current.id)
  }, 20_000)

  it('answers no for a missing hash or input that is not a PIN, after the same work', async () => {
    expect((await verifyPin('482913', null, keyring)).ok).toBe(false)
    expect((await verifyPin('48291', await hashPin('482913', keyring, CHEAP), keyring)).ok).toBe(false)
    expect((await verifyPin(undefined, undefined, keyring)).ok).toBe(false)
    await expect(hashPin('12345', keyring)).rejects.toThrow(/6 digits/)
    expect(() => pinPepper('short')).toThrow()
  }, 20_000)
})

describe('PIN lockout: five wrong PINs lock the worker, not the device', () => {
  it('locks at the fifth wrong PIN for 5 minutes, then doubles up to an hour', () => {
    expect(PIN_LOCKOUT.maxFailures).toBe(5)
    expect([1, 2, 3, 4].map(pinLockMsAfter)).toEqual([0, 0, 0, 0])
    expect(pinLockMsAfter(5)).toBe(5 * 60_000)
    expect(pinLockMsAfter(6)).toBe(10 * 60_000)
    expect(pinLockMsAfter(20)).toBe(60 * 60_000)
    expect(pinLockUntil(4, NOW)).toBeNull()
    expect(pinLockUntil(5, NOW)).toEqual(new Date(NOW.getTime() + 5 * 60_000))
  })

  it('is locked only before the lock ends', () => {
    expect(isPinLocked({ pinLockedUntil: null }, NOW)).toBe(false)
    expect(isPinLocked({ pinLockedUntil: new Date(NOW.getTime() + 1) }, NOW)).toBe(true)
    expect(isPinLocked({ pinLockedUntil: NOW }, NOW)).toBe(false)
  })
})

describe('badge codes (PLT-019, 128 random bits)', () => {
  it('are 26 Crockford base32 characters, different each time', () => {
    const codes = new Set(Array.from({ length: 200 }, () => newBadgeCode()))
    expect(codes.size).toBe(200)
    for (const code of codes) expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
    // 128 bits: the last character carries 3 bits followed by two zero bits.
    for (const code of codes) expect('048CGMRW').toContain(code.at(-1))
  })

  it('normalize scanned or typed input, and refuse anything else', () => {
    const code = newBadgeCode()
    expect(normalizeBadgeCode(printedBadgeCode(code))).toBe(code)
    expect(normalizeBadgeCode(code.toLowerCase())).toBe(code)
    expect(normalizeBadgeCode('O'.repeat(26))).toBe('0'.repeat(26))
    expect(normalizeBadgeCode('U'.repeat(26))).toBeNull()
    expect(normalizeBadgeCode('ABC')).toBeNull()
    expect(normalizeBadgeCode(42)).toBeNull()
  })

  it('are stored as a hash of the normalized code; the hint is the last four characters', () => {
    const code = newBadgeCode()
    expect(badgeCodeHash(code)).toMatch(/^[0-9a-f]{64}$/)
    expect(badgeCodeHash(printedBadgeCode(code).toLowerCase())).toBe(badgeCodeHash(code))
    expect(badgeCodeHash(newBadgeCode())).not.toBe(badgeCodeHash(code))
    expect(badgeHint(code)).toBe(code.slice(-4))
    expect(() => badgeCodeHash('nope')).toThrow()
  })
})

describe('floor session times (PLT-060)', () => {
  const rome = { shiftEnds: ['06:00', '14:00', '22:00'], timeZone: 'Europe/Rome' }

  it('ends at the first shift end at least 30 minutes away, in the site time zone', () => {
    // 09:00 UTC = 10:00 in Rome (CET, after the October change) → the 14:00 end (13:00 UTC).
    expect(sessionEndsAt(NOW, rome)).toEqual(new Date('2026-10-28T13:00:00.000Z'))
    // 12:45 UTC = 13:45 in Rome: 14:00 is too close, so 22:00 (21:00 UTC).
    expect(sessionEndsAt(new Date('2026-10-28T12:45:00.000Z'), rome)).toEqual(new Date('2026-10-28T21:00:00.000Z'))
    // 21:40 UTC = 22:40 in Rome → 06:00 next day (05:00 UTC).
    expect(sessionEndsAt(new Date('2026-10-28T21:40:00.000Z'), rome)).toEqual(new Date('2026-10-29T05:00:00.000Z'))
  })

  it('never lasts more than 12 hours, also without shift ends', () => {
    expect(sessionEndsAt(NOW, { shiftEnds: [], timeZone: 'Europe/Rome' })).toEqual(new Date(NOW.getTime() + FLOOR_SESSION.maxMs))
    expect(sessionEndsAt(NOW, { shiftEnds: ['09:30'], timeZone: 'Europe/Rome' })).toEqual(new Date(NOW.getTime() + FLOOR_SESSION.maxMs))
  })

  it('reads wall-clock times across a clock change', () => {
    expect(zonedInstant('2026-07-01', '14:00', 'Europe/Rome')).toEqual(new Date('2026-07-01T12:00:00.000Z'))
    expect(zonedInstant('2026-12-01', '14:00', 'Europe/Rome')).toEqual(new Date('2026-12-01T13:00:00.000Z'))
    expect(() => zonedInstant('2026-12-01', '25:00', 'Europe/Rome')).toThrow()
  })

  it('slides the idle end, never past the session end', () => {
    const endsAt = new Date(NOW.getTime() + 5 * 60_000)
    expect(idleEndAt(NOW, 10, new Date(NOW.getTime() + 60 * 60_000))).toEqual(new Date(NOW.getTime() + 10 * 60_000))
    expect(idleEndAt(NOW, 10, endsAt)).toEqual(endsAt)
  })

  it('says whether a session is live, idle, past its shift end or ended', () => {
    const live = { endedAt: null, idleExpiresAt: new Date(NOW.getTime() + 1), endsAt: new Date(NOW.getTime() + 2) }
    expect(sessionState(live, NOW)).toBe('live')
    expect(sessionState({ ...live, idleExpiresAt: NOW }, NOW)).toBe('idle')
    expect(sessionState({ ...live, endsAt: NOW }, NOW)).toBe('shift_end')
    expect(sessionState({ ...live, endedAt: NOW }, NOW)).toBe('ended')
  })

  it('checks a site setting: idle minutes 1 to 120, shift ends HH:MM once each', () => {
    expect(timingProblems({ idleMinutes: 10, shiftEnds: ['06:00', '14:00'] })).toEqual([])
    expect(timingProblems({ idleMinutes: 0, shiftEnds: [] })[0]?.path).toBe('idleMinutes')
    expect(timingProblems({ idleMinutes: 10, shiftEnds: ['6:00'] })[0]?.path).toBe('shiftEnds/0')
    expect(timingProblems({ idleMinutes: 10, shiftEnds: ['06:00', '06:00'] })[0]?.path).toBe('shiftEnds')
  })
})

describe('the floor machines', () => {
  it('enrols a pending device once, revokes for good', () => {
    assertTransition(deviceStatus, 'PENDING', 'ACTIVE')
    assertTransition(deviceStatus, 'ACTIVE', 'REVOKED')
    expect(() => assertTransition(deviceStatus, 'ACTIVE', 'PENDING')).toThrow()
    expect(() => assertTransition(deviceStatus, 'REVOKED', 'ACTIVE')).toThrow()
    expect(deviceStatus.finals).toEqual(['REVOKED'])
  })

  it('deactivates and reactivates a worker; a revoked or lost badge stays so', () => {
    assertTransition(workerStatus, 'ACTIVE', 'INACTIVE')
    assertTransition(workerStatus, 'INACTIVE', 'ACTIVE')
    assertTransition(badgeStatus, 'ACTIVE', 'LOST')
    expect(() => assertTransition(badgeStatus, 'LOST', 'ACTIVE')).toThrow()
  })
})

describe('floor roles and their grants', () => {
  it('floor templates hold only floor permissions, no money and no two-factor; office templates hold no floor permission', () => {
    expect(templateProblems(ROLE_TEMPLATES)).toEqual([])
    const floor = ROLE_TEMPLATES.filter((entry) => entry.audience === 'floor')
    expect(floor.map((entry) => entry.key)).toEqual(['operator', 'cutting_operator', 'floor_inspector', 'team_leader', /* B-W2a-35 */ 'technician'])
    for (const entry of floor) {
      expect(entry.requireMfa).toBe(false)
      expect(entry.grains).toEqual([])
      // floor.* only, and the few office permissions shared with the floor (printing labels at the device's site).
      expect(entry.permissions.every((name) => name.startsWith('floor.') || (FLOOR_SHARED_PERMISSIONS as readonly string[]).includes(name))).toBe(true)
      expect(entry.permissions).toEqual(expect.arrayContaining(['print.labels', 'print.view']))
    }
    for (const entry of ROLE_TEMPLATES.filter((item) => item.audience === 'office')) {
      expect(entry.permissions.some((name) => name.startsWith('floor.')), entry.key).toBe(false)
    }
    expect(templateOf('team_leader')?.permissions).toEqual(['floor.lead', 'floor.work', 'inventory.issue', 'inventory.locations.view', 'inventory.receive', 'inventory.transfer', /* B-W2a-35 */ 'plant.report', 'print.labels', 'print.view', 'production.bundles', 'production.cut', 'production.rework', 'production.scan', /* B-W2b-46 */ 'production.scan.override', 'production.serials', /* B-W2a-76 */ 'purchasing.subcontract.kit', 'purchasing.subcontract.receive', 'quality.inspections.view', /* B-W2a-43 */ 'sales.returns.receive', 'shipping.pack'])
    expect(templateOf('floor_inspector')?.permissions).toEqual(expect.arrayContaining(['quality.inspections.record', 'quality.garments.release']))
    expect(templateOf('floor_inspector')?.permissions).not.toContain('quality.garments.reverse')
    expect(templateOf('admin')?.permissions).toEqual(expect.arrayContaining(['devices.manage', 'devices.revoke', 'workers.manage', 'workers.credentials']))
  })

  it('finds a floor role that names an office permission, a grain other than wages, or two-factor', () => {
    expect(audienceProblems({ audience: 'floor', permissions: ['users.view'], grains: ['cost'], requireMfa: true })).toEqual([
      'a floor role holds only floor permissions, not users.view',
      'a floor role sees at most wages, not cost',
      'a floor role cannot require two-factor',
    ])
    expect(audienceProblems({ audience: 'floor', permissions: ['floor.work'], grains: ['wages'], requireMfa: false })).toEqual([])
    expect(audienceProblems({ audience: 'floor', permissions: ['floor.work', 'print.view', 'print.labels'], grains: [], requireMfa: false })).toEqual([])
    expect(audienceProblems({ audience: 'floor', permissions: ['print.manage', 'print.documents', 'files.read'], grains: [], requireMfa: false })).toEqual([
      'a floor role holds only floor permissions, not print.manage',
      'a floor role holds only floor permissions, not print.documents',
      'a floor role holds only floor permissions, not files.read',
    ])
    expect(audienceProblems({ audience: 'office', permissions: ['floor.work'], grains: [], requireMfa: false })).toEqual(['floor.work is held only by floor roles'])
    expect(roleProblems({ name: 'Copy', requireMfa: false, permissions: ['floor.work'], grains: [] })[0]?.message).toMatch(/only by floor roles/)
    expect(FACTORY_PERMISSIONS.get('floor.work')?.area).toBe('floor')
  })

  it('gives one grant per role over the device company and site, and at most wages', () => {
    const grants = floorGrants(
      [
        { permissions: ['floor.work'], grains: [] },
        { permissions: ['floor.lead', 'money.cost'], grains: ['cost', 'margin', 'price', 'wages'] },
      ],
      { companyId: COMPANY, siteId: SITE },
    )
    expect(grants).toEqual([
      { permissions: ['floor.work'], companies: [COMPANY], sites: [SITE], parties: 'all' },
      { permissions: ['floor.lead', 'money.wages'], companies: [COMPANY], sites: [SITE], parties: 'all' },
    ])
    expect(FLOOR_GRAINS).toEqual(['wages'])
    const actor = { audience: 'floor' as const, tenantId: COMPANY, siteId: SITE, grants }
    expect([...heldGrains(actor)]).toEqual(['wages'])
  })

  it('gives nothing while the PIN must change', () => {
    expect(floorGrants([{ permissions: ['floor.work'], grains: [] }], { companyId: COMPANY, siteId: SITE }, { pinMustChange: true })).toEqual([])
  })
})
