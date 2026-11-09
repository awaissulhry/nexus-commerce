import { describe, expect, it } from 'vitest'
import { CAPABILITIES, PARTNER_KINDS } from '@nexus/factory-domain/auth/partners/kinds'
import { PARTNER_WORDS } from '@nexus/factory-domain/auth/partners/rules'
import { PARTNER_ROLE_TEMPLATES } from '@nexus/factory-domain/auth/roles/templates'
import { ASKABLE_KINDS } from '@nexus/factory-domain/portal/tasks/rules'
import { ApiError } from '../../../../lib/api/errors'
import { messagesFor } from '../../../../lib/i18n/messages'
import { ASKABLE, PERSON_ACTIONS } from '../../../admin/users/partners/api'
import {
  dayOf,
  endOfDay,
  endsSoon,
  inviteBody,
  inviteHeld,
  inviteProblems,
  partnerChangeOf,
  partnerProblem,
  partnerTileCounts,
  partnerUserReach,
  partnerUserRows,
  personBody,
  personDraftOf,
  personReach,
  portalAddress,
  previewHeld,
  roleChoices,
  settingsBody,
  settingsDraftOf,
  settingsProblems,
  signedInOf,
  blankInvite,
} from '../../../admin/users/partners/model'
import { ORGANISATIONS, PARTNER_USERS } from '../../../admin/users/partners/fixtures'
import { recordTabs, SIDES } from '../../../parties/_shared/model'
import { RECORD_CAN } from '../../../parties/_shared/fixtures'
import { ALL_RIGHTS, CUSTOMER_PEOPLE, customerAccess, DEMO_NOW, DEMO_TODAY, READ_ONLY, supplierAccess } from './demo'
import { showsPrices } from './model'

const marco = CUSTOMER_PEOPLE[1]!
const sara = CUSTOMER_PEOPLE[2]!
const paolo = CUSTOMER_PEOPLE[3]!
const elena = CUSTOMER_PEOPLE[4]!
const luca = CUSTOMER_PEOPLE[5]!

describe('Portal access in the office (B-W2b-180)', () => {
  it('an end of access chosen as a day lasts the whole day in Rome, across the clock change', () => {
    expect(endOfDay('2026-12-31')).toBe('2026-12-31T22:59:59.000Z')
    expect(endOfDay('2026-07-15')).toBe('2026-07-15T21:59:59.000Z')
    expect(endOfDay('2026-10-25')).toBe('2026-10-25T22:59:59.000Z')
    expect(dayOf(endOfDay('2026-03-29'))).toBe('2026-03-29')
    expect(dayOf('2026-10-28T23:30:00.000Z')).toBe('2026-10-29')
  })

  it('"access ends soon" is within 7 days and not past', () => {
    const now = new Date(DEMO_NOW)
    expect(endsSoon(sara.accessUntil, now)).toBe(true)
    expect(endsSoon('2026-12-31T22:59:59.000Z', now)).toBe(false)
    expect(endsSoon('2026-10-28T10:00:00.000Z', now)).toBe(false)
    expect(endsSoon(null, now)).toBe(false)
  })

  it('a bulk action reaches only the people its state machine allows, and says why it is held', () => {
    const picked = [marco, paolo, elena, luca]
    expect(personReach('suspend', picked, ALL_RIGHTS).items).toEqual([marco])
    expect(personReach('reactivate', picked, ALL_RIGHTS).items).toEqual([elena])
    expect(personReach('deactivate', picked, ALL_RIGHTS).items).toEqual([marco, elena])
    expect(personReach('resend', picked, ALL_RIGHTS).items).toEqual([paolo])
    expect(personReach('revoke', picked, ALL_RIGHTS).items).toEqual([paolo])
    expect(personReach('suspend', [luca], ALL_RIGHTS).held).toBe('held.suspendNone')
    expect(personReach('suspend', picked, READ_ONLY)).toMatchObject({ held: 'right.manage', items: [] })
    expect(personReach('resend', picked, READ_ONLY).held).toBe('right.invite')
  })

  it('invite is held in order: the right, no portal kind, blocked, the terms, the seats', () => {
    expect(inviteHeld(customerAccess(), ALL_RIGHTS)).toBeNull()
    expect(inviteHeld(customerAccess(), READ_ONLY)).toBe('right.invite')
    expect(inviteHeld(customerAccess({ kinds: [] }), ALL_RIGHTS)).toBe('held.noKind')
    expect(inviteHeld(customerAccess({ party: { ...customerAccess().party, status: 'BLOCKED' } }), ALL_RIGHTS)).toBe('held.blocked')
    expect(inviteHeld(customerAccess({ termsInForce: false }), ALL_RIGHTS)).toBe('held.noTerms')
    expect(inviteHeld(customerAccess({ seats: { taken: 5, max: 5 } }), ALL_RIGHTS)).toBe('held.seatsFull')
    expect(previewHeld(customerAccess(), READ_ONLY)).toBe('right.preview')
    expect(previewHeld(customerAccess({ kinds: [] }), ALL_RIGHTS)).toBe('held.noKind')
  })

  it('the invite: a blank one takes the only portal and its first non-admin role; problems in words; the body', () => {
    const access = customerAccess()
    const blank = blankInvite(access)
    expect(blank).toMatchObject({ kind: 'CUSTOMER', roleKey: 'customer-buyer', capabilities: ['comment', 'upload', 'approve'], until: '' })
    expect(inviteProblems(blank, access, DEMO_TODAY)).toEqual({ name: 'form.required', email: 'form.email' })
    expect(inviteProblems({ ...blank, name: 'X', email: marco.email.toUpperCase(), until: DEMO_TODAY }, access, DEMO_TODAY)).toEqual({ email: 'invite.exists', until: 'invite.untilFuture' })
    const notOffered = customerAccess({ roles: customerAccess().roles.map((role) => (role.key === 'customer-viewer' ? { ...role, offered: false } : role)) })
    expect(inviteProblems({ ...blank, name: 'X', email: 'x@example.com', roleKey: 'customer-viewer' }, notOffered, DEMO_TODAY)).toEqual({ roleKey: 'invite.roleNotOffered' })
    expect(roleChoices(notOffered.roles, 'CUSTOMER').map((role) => role.key)).not.toContain('customer-viewer')
    expect(roleChoices(customerAccess().roles, 'CUSTOMER').at(-1)?.admin).toBe(true)
    expect(inviteBody({ ...blank, name: ' Nadia ', email: ' nadia@example.com ', until: '2026-12-31' })).toEqual({
      email: 'nadia@example.com',
      displayName: 'Nadia',
      locale: 'it',
      kind: 'CUSTOMER',
      roleKey: 'customer-buyer',
      capabilities: ['comment', 'upload', 'approve'],
      accessUntil: '2026-12-31T22:59:59.000Z',
    })
  })

  it('a change sends only what changes, with the version read', () => {
    expect(personBody(sara, personDraftOf(sara))).toBeNull()
    expect(personBody(sara, { ...personDraftOf(sara), until: '' })).toEqual({ version: sara.version, accessUntil: null })
    expect(personBody(marco, { ...personDraftOf(marco), roleKey: 'customer-quality', capabilities: ['comment'] })).toEqual({ version: marco.version, roleKey: 'customer-quality', capabilities: ['comment'] })
  })

  it('the portal card sends only what changes; the limit cannot drop below the people already in', () => {
    const saved = customerAccess().settings
    expect(settingsBody(saved, settingsDraftOf(saved))).toBeNull()
    expect(settingsBody(saved, { ...settingsDraftOf(saved), progressShared: true, maxUsers: '' })).toEqual({ version: 4, progressShared: true, maxUsers: null })
    expect(settingsProblems({ ...settingsDraftOf(saved), maxUsers: '3' }, { taken: 5, max: 10 })).toEqual({ maxUsers: 'settings.maxBelowTaken' })
    expect(settingsProblems({ ...settingsDraftOf(saved), maxUsers: '0' }, { taken: 0, max: null })).toEqual({ maxUsers: 'settings.maxRange' })
  })

  it("a refusal is said in this screen's words, never the API's English", () => {
    const conflict = (message: string, issues: Array<{ path: string; message: string }> = []) => new ApiError('conflict', 409, 'conflict', message, 'r', issues)
    expect(partnerProblem(conflict(PARTNER_WORDS.officeAddress, [{ path: 'email', message: PARTNER_WORDS.officeAddress }]))).toBe('problem.officeAddress')
    expect(partnerProblem(conflict(PARTNER_WORDS.alreadyIn))).toBe('problem.alreadyIn')
    expect(partnerProblem(conflict('The portal of Moda Demo holds at most 5 people, and 5 are invited or active. Deactivate someone first, or ask for more.'))).toBe('problem.seatsFull')
    expect(partnerProblem(new ApiError('invalid', 400, 'validation_failed', 'The access is not valid.', 'r', [{ path: 'roleKey', message: 'x' }]))).toBe('problem.roleNotOffered')
    expect(partnerProblem(new ApiError('forbidden', 403, 'forbidden', 'x', 'r'))).toBe('problem.forbidden')
    expect(partnerProblem(conflict('The portal terms of this company are not published yet (Admin › Privacy & notices): nobody outside can sign in to its portal before they are.'))).toBe('problem.noTerms')
    expect(partnerProblem(new Error('x'))).toBe('problem.internal')
  })

  it('the preview opens the portal Home, or one record through the frame', () => {
    expect(portalAddress('MODA-DEMO')).toBe('/p/MODA-DEMO')
    expect(portalAddress('A B', { type: 'SalesOrder', id: 'o/1' })).toBe('/p/A%20B/open/SalesOrder/o%2F1')
  })

  it('live: a partner event of this party reads the tab again; a sign-in names its person', () => {
    const party = customerAccess().party.id
    expect(partnerChangeOf({ type: 'partner_user.signed_in', fields: { partyId: party, userId: marco.id } }, party)).toBe(true)
    expect(partnerChangeOf({ type: 'partner_user.signed_in', fields: { partyId: 'other' } }, party)).toBe(false)
    expect(partnerChangeOf({ type: 'party.vies_checked', fields: { partyId: party } }, party)).toBe(false)
    expect(signedInOf({ type: 'partner_user.signed_in', fields: { userId: marco.id } })).toBe(marco.id)
    expect(signedInOf({ type: 'partner_user.changed', fields: { userId: marco.id } })).toBeNull()
  })

  it('suppliers and workshops never get a prices column (C2)', () => {
    expect(showsPrices(customerAccess())).toBe(true)
    expect(showsPrices(supplierAccess())).toBe(false)
  })

  it('the party record shows Portal access only with partners.view, on both sides', () => {
    expect(recordTabs(SIDES.customers, { ...RECORD_CAN, partners: true })).toContain('portal')
    expect(recordTabs(SIDES.suppliers, { ...RECORD_CAN, partners: true })).toContain('portal')
    expect(recordTabs(SIDES.customers, RECORD_CAN)).not.toContain('portal')
  })

  it('Admin › Users Partners: by organisation, deactivated only under its tile; the tile counts; bulk through the partner routes', () => {
    const now = new Date(DEMO_NOW)
    const rows = partnerUserRows(PARTNER_USERS, ORGANISATIONS.organisations, null, '', now)
    expect(rows.map((row) => row.organisation?.party.code)).toEqual(['CONCERIA-DEMO', 'CONCERIA-DEMO', 'CONCERIA-DEMO', 'MODA-DEMO', 'MODA-DEMO', 'MODA-DEMO', 'MODA-DEMO', 'MODA-DEMO'])
    expect(partnerUserRows(PARTNER_USERS, ORGANISATIONS.organisations, 'deactivated', '', now).map((row) => row.user.displayName)).toEqual(['Luca Passato'])
    expect(partnerUserRows(PARTNER_USERS, ORGANISATIONS.organisations, 'endsSoon', '', now).map((row) => row.user.displayName)).toEqual(['Sara Demo'])
    expect(partnerUserRows(PARTNER_USERS, ORGANISATIONS.organisations, null, 'conceria', now)).toHaveLength(3)
    expect(partnerTileCounts(PARTNER_USERS, ORGANISATIONS.counts, now)).toEqual({ invited: 2, endsSoon: 1, suspended: 1, deactivated: 1 })
    expect(partnerTileCounts(null, null, now).invited).toBeNull()
    const picked = PARTNER_USERS.filter((user) => ['Marco Prova', 'Elena Modello', 'Paolo Campione'].includes(user.displayName))
    expect(partnerUserReach('deactivate', picked, ALL_RIGHTS).items.map((user) => user.displayName)).toEqual(['Marco Prova', 'Elena Modello'])
    expect(partnerUserReach('suspend', picked, READ_ONLY).held).toBe('right.manage')
    expect(PERSON_ACTIONS).toEqual(['suspend', 'reactivate', 'deactivate'])
  })

  it('every partner role, kind, capability, status and request kind has words in both languages', () => {
    expect([...ASKABLE]).toEqual([...ASKABLE_KINDS])
    for (const locale of ['it', 'en'] as const) {
      const words = messagesFor(locale, ['portal-access'])['portal-access']!
      for (const template of PARTNER_ROLE_TEMPLATES) {
        expect(words[`role.${template.key}`], `${locale} role.${template.key}`).toBeTruthy()
        expect(words[`roleLine.${template.key}`], `${locale} roleLine.${template.key}`).toBeTruthy()
      }
      for (const kind of PARTNER_KINDS) expect(words[`kind.${kind}`], `${locale} kind.${kind}`).toBeTruthy()
      for (const capability of CAPABILITIES) expect(words[`capability.${capability}`] && words[`capabilityLine.${capability}`], `${locale} ${capability}`).toBeTruthy()
      for (const kind of ASKABLE) expect(words[`ask.kind.${kind}`] && words[`ask.kindLine.${kind}`], `${locale} ${kind}`).toBeTruthy()
      for (const status of ['INVITED', 'ACTIVE', 'SUSPENDED', 'DEACTIVATED']) expect(words[`status.${status}`]).toBeTruthy()
    }
  })
})
