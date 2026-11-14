import { afterEach, describe, expect, it } from 'vitest'
import type { Prisma } from '@nexus/factory-db'
import { newId } from '@nexus/factory-domain/core/ids'
import { useReadLog } from '../reads/switch'
import { detailsOf } from './details'
import { eventsOfRow, readLogRows, securityEventRows, type LedgerWriter } from './ledgers'
import { forgetOrigin, rememberOrigin } from './origin'

/**
 * The security events and reads that ARE audit rows (B-W2b-399; PLT-074, PLT-075): which rows make which event, who it
 * names, where it was, and that its details are codes only (never an address or free text).
 */

const person = newId()
const worker = newId()
const device = newId()
const site = newId()
const party = newId()

const row = (action: string, extra: Partial<Prisma.AuditLogCreateManyInput> = {}): Prisma.AuditLogCreateManyInput => ({
  id: newId(),
  at: new Date('2026-11-01T09:00:00.000Z'),
  audience: 'OFFICE',
  actorId: person,
  action,
  recordType: 'User',
  recordId: person,
  requestId: 'req-1',
  ...extra,
})
const office: LedgerWriter = { audience: 'OFFICE', actorId: person, siteId: null, partyId: null, requestId: 'req-1' }

afterEach(() => {
  useReadLog(undefined)
  forgetOrigin('req-1')
})

describe('which audit rows are security events', () => {
  it('a sign-in, its refusals and the lock they set', () => {
    expect(eventsOfRow(row('auth.signIn', { recordType: 'Session', after: { userId: person, secondFactor: 'totp' } }))).toEqual([{ kind: 'SIGN_IN', details: { secondFactor: 'TOTP' } }])
    expect(eventsOfRow(row('auth.signInFailed', { after: { wrong: 'password', failedAttempts: 2, lockedUntil: null } }))).toEqual([{ kind: 'SIGN_IN_FAILED', details: { reason: 'WRONG_PASSWORD', failedAttempts: 2 } }])
    const locked = eventsOfRow(row('auth.signInFailed', { after: { wrong: 'code', failedAttempts: 5, lockedUntil: '2026-11-01T09:01:00.000Z' } }))
    expect(locked.map((made) => [made.kind, made.details])).toEqual([
      ['SIGN_IN_FAILED', { reason: 'WRONG_CODE', failedAttempts: 5 }],
      ['LOCKOUT', { what: 'ACCOUNT', lockedUntil: '2026-11-01T09:01:00.000Z' }],
    ])
    // A wrong step-up code is no sign-in, but the lock it sets is a lockout.
    expect(eventsOfRow(row('auth.stepUpFailed', { after: { wrong: 'code', failedAttempts: 4, lockedUntil: null } }))).toEqual([])
    expect(eventsOfRow(row('auth.stepUpFailed', { after: { wrong: 'code', failedAttempts: 5, lockedUntil: '2026-11-01T09:01:00.000Z' } })).map((made) => made.kind)).toEqual(['LOCKOUT'])
  })

  it('two-factor set up or switched off; a role given, ended or edited, a worker’s floor roles, a role’s two-factor rule', () => {
    expect(eventsOfRow(row('auth.totpConfirm'))).toEqual([{ kind: 'MFA_CHANGED', details: { change: 'SET_UP' } }])
    expect(eventsOfRow(row('auth.totpDisable'))).toEqual([{ kind: 'MFA_CHANGED', details: { change: 'SWITCHED_OFF' } }])
    for (const [action, recordType] of [['roles.assign', 'RoleAssignment'], ['roles.unassign', 'RoleAssignment'], ['roles.edit', 'Role'], ['roles.create', 'Role'], ['roles.syncTemplates', 'Role'], ['workers.setRoles', 'Worker'], ['security.setRoleTwoFactor', 'Role'], ['users.acceptInvitation', 'RoleAssignment']] as const) {
      expect(eventsOfRow(row(action, { recordType })), action).toEqual([{ kind: 'ROLE_CHANGED', details: { change: action } }])
    }
    // Bookkeeping, not a change of rights; a notification default of a role is no role change either.
    expect(eventsOfRow(row('roles.twoFactorSince', { recordType: 'Role' }))).toEqual([])
    expect(eventsOfRow(row('notifications.setRoleDefault', { recordType: 'Role' }))).toEqual([])
  })

  it('the floor: the worker signed in, a wrong PIN for the worker (the device wrote it) and the PIN lock', () => {
    expect(eventsOfRow(row('floor.signIn', { audience: 'FLOOR', actorId: worker, recordType: 'FloorSession', recordId: newId(), after: { workerId: worker, method: 'badge', pin: true } }))).toEqual([
      { kind: 'SIGN_IN', actorId: worker, details: { method: 'BADGE', pin: true, switch: undefined } },
    ])
    const wrong = eventsOfRow(row('floor.signInFailed', { audience: 'FLOOR', actorId: device, recordType: 'Worker', recordId: worker, after: { wrong: 'pin', failedPinAttempts: 5, lockedUntil: '2026-11-01T09:05:00.000Z' } }))
    expect(wrong.map((made) => [made.kind, made.actorId, made.details])).toEqual([
      ['SIGN_IN_FAILED', worker, { reason: 'WRONG_PIN', failedAttempts: 5 }],
      ['LOCKOUT', worker, { what: 'PIN', lockedUntil: '2026-11-01T09:05:00.000Z' }],
    ])
  })

  it('the portal: a sign-in with its party, a wrong code, the last try locks the code, a right code refused', () => {
    expect(eventsOfRow(row('portal.signIn', { recordType: 'Session', after: { userId: person, partyId: party, method: 'CODE' } }))).toEqual([{ kind: 'SIGN_IN', surface: 'PORTAL', partyId: party, details: { method: 'CODE' } }])
    expect(eventsOfRow(row('portal.signInFailed', { recordType: 'PortalSignInCode', after: { tries: 2, method: 'CODE' } })).map((made) => made.kind)).toEqual(['SIGN_IN_FAILED'])
    expect(eventsOfRow(row('portal.signInFailed', { recordType: 'PortalSignInCode', after: { tries: 5, method: 'CODE' } })).map((made) => made.kind)).toEqual(['SIGN_IN_FAILED', 'LOCKOUT'])
    expect(eventsOfRow(row('portal.signInCodeChecked', { recordType: 'PortalSignInCode', after: { method: 'CODE', refused: 'PAUSED' } }))).toEqual([{ kind: 'SIGN_IN_FAILED', surface: 'PORTAL', details: { reason: 'PAUSED' } }])
    expect(eventsOfRow(row('portal.signInCodeChecked', { recordType: 'PortalSignInCode', after: { method: 'CODE', refused: null } }))).toEqual([])
  })

  it('an export: a list’s file asked for, an accounting or payroll package once EXPORTED (not its draft)', () => {
    const exportJob = row('exports.request', { recordType: 'ExportJob', recordId: newId(), after: { listKey: 'sales.orders', format: 'CSV', status: 'QUEUED' } })
    expect(eventsOfRow(exportJob)).toEqual([{ kind: 'EXPORT', details: { action: 'exports.request', listKey: 'sales.orders', format: 'CSV' } }])
    expect(eventsOfRow(row('accounting.export', { recordType: 'AccountingExport', after: { status: 'EXPORTED' } })).map((made) => made.kind)).toEqual(['EXPORT'])
    expect(eventsOfRow(row('people.exportPayroll', { recordType: 'PayrollExport', after: { status: 'EXPORTED' } })).map((made) => made.kind)).toEqual(['EXPORT'])
    expect(eventsOfRow(row('people.exportPayroll', { recordType: 'PayrollExport', after: { status: 'DRAFT' } }))).toEqual([])
    // The other rows of the same command (a leaver's step ticked) are not exports.
    expect(eventsOfRow(row('people.leaverStepTicked', { recordType: 'Employee' }))).toEqual([])
    expect(eventsOfRow(row('exports.finish', { recordType: 'ExportJob', after: { status: 'DONE' } }))).toEqual([])
  })

  it('most commands make none', () => {
    for (const action of ['sales.createOrder', 'files.completeUpload', 'auth.signOut', 'numbering.closeSeries', 'audit.searchReadsOfPerson']) expect(eventsOfRow(row(action)), action).toEqual([])
  })
})

describe('the rows command() writes beside the audit rows', () => {
  it('an office sign-in carries the request’s address hash; nothing is set that the database refuses', () => {
    rememberOrigin('req-1', 'a'.repeat(64))
    const [event] = securityEventRows([row('auth.signIn', { recordType: 'Session', recordId: newId(), after: { secondFactor: null } })], { ...office, siteId: site })
    expect(event).toMatchObject({ kind: 'SIGN_IN', surface: 'OFFICE', actorId: person, ipHash: 'a'.repeat(64), ipCountry: null, siteId: null, partyId: null, recordType: 'Session', details: { secondFactor: 'NONE' } })
  })

  it('the floor keeps the device’s site; the portal’s office command is the PORTAL with the party; the system is the SYSTEM', () => {
    const floor: LedgerWriter = { audience: 'FLOOR', actorId: device, siteId: site, partyId: null, requestId: 'req-2' }
    const [pin] = securityEventRows([row('floor.signInFailed', { audience: 'FLOOR', actorId: device, recordType: 'Worker', recordId: worker, after: { failedPinAttempts: 1, lockedUntil: null } })], floor)
    expect(pin).toMatchObject({ surface: 'FLOOR', siteId: site, actorId: worker, ipHash: null })
    const [portal] = securityEventRows([row('portal.signIn', { recordType: 'Session', after: { partyId: party, method: 'LINK' } })], office)
    expect(portal).toMatchObject({ surface: 'PORTAL', partyId: party, siteId: null })
    const [system] = securityEventRows([row('roles.syncTemplates', { audience: 'SYSTEM', recordType: 'Role' })], { audience: 'SYSTEM', actorId: newId(), siteId: null, partyId: null, requestId: 'job' })
    expect(system).toMatchObject({ surface: 'SYSTEM', kind: 'ROLE_CHANGED', recordType: 'Role' })
  })

  it('an export by an office person is an EXPORT read of it, only with the read log switched on; never another audience’s', () => {
    const exportRow = row('exports.request', { recordType: 'ExportJob', recordId: newId(), after: { listKey: 'sales.orders' } })
    useReadLog(true)
    expect(readLogRows([exportRow, row('sales.createOrder')], office)).toEqual([expect.objectContaining({ userId: person, recordType: 'ExportJob', recordId: exportRow.recordId, action: 'EXPORT', surface: 'OFFICE' })])
    expect(readLogRows([exportRow], { ...office, audience: 'SYSTEM' })).toEqual([])
    useReadLog(false)
    expect(readLogRows([exportRow], office)).toEqual([])
  })
})

describe('details are codes only', () => {
  it('keeps codes, numbers, true/false and lists of them; leaves out an address, free text, objects and bad keys', () => {
    expect(
      detailsOf({
        reason: 'WRONG_PASSWORD',
        tries: 3,
        pin: false,
        none: null,
        route: 'GET /audit/reads',
        list: ['A', 'B'],
        email: 'someone@example.com',
        words: 'line one\nline two',
        nested: { a: 1 },
        BadKey: 'X',
        later: undefined,
        mixed: ['A', 'b@c.d'],
      }),
    ).toEqual({ reason: 'WRONG_PASSWORD', tries: 3, pin: false, none: null, route: 'GET /audit/reads', list: ['A', 'B'] })
  })

  it('at most 20 keys; a string of at most 200 characters', () => {
    const many = Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`key${index}`, index]))
    expect(Object.keys(detailsOf(many))).toHaveLength(20)
    expect(detailsOf({ long: 'A'.repeat(201), fits: 'A'.repeat(200) })).toEqual({ fits: 'A'.repeat(200) })
  })
})
