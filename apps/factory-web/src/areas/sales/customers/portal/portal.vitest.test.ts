import { describe, expect, it } from 'vitest'
// F-SA-272: the supervisor moved to the customer's Overview (its own card and Apply).
import { readFileSync } from 'node:fs'
import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { I18nProvider } from '../../../../lib/i18n/provider'
import type { DesignScreen } from '../../../../lib/design/design-screen'
import { designScreen as customerRecordScreen } from '../record/fixtures'
import { OFFICE_PEOPLE, productionLimits, SUPERVISOR_CASES } from './demo'
import { limitsDraftOf, saveLimits } from './limits/model'
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
// B-CP-011 (follow-up 15): Portal access holds a role only the Owner gives before the click.
import { firstRole, personProblems, roleHeld } from '../../../admin/users/partners/model'
import type { PartnerPerson, PortalAccess } from '../../../admin/users/partners/api'
import { rolesOf } from './demo'

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
    expect(settingsBody(saved, { ...settingsDraftOf(saved), portalOn: false, maxUsers: '' })).toEqual({ version: 4, portalOn: false, maxUsers: null })
    expect(settingsProblems({ ...settingsDraftOf(saved), maxUsers: '3' }, { taken: 5, max: 10 })).toEqual({ maxUsers: 'settings.maxBelowTaken' })
    expect(settingsProblems({ ...settingsDraftOf(saved), maxUsers: '0' }, { taken: 0, max: null })).toEqual({ maxUsers: 'settings.maxRange' })
  })

  it("a refusal is said in this screen's words, never the API's English", () => {
    const conflict = (message: string, issues: Array<{ path: string; message: string }> = []) => new ApiError('conflict', 409, 'conflict', message, 'r', issues)
    expect(partnerProblem(conflict(PARTNER_WORDS.officeAddress, [{ path: 'email', message: PARTNER_WORDS.officeAddress }]))).toBe('problem.officeAddress')
    expect(partnerProblem(conflict(PARTNER_WORDS.alreadyIn))).toBe('problem.alreadyIn')
    // B-TH-202 (B-TH-007): the office's Portal access keeps the real reason (the portal hears one neutral sentence).
    expect(partnerProblem(conflict(PARTNER_WORDS.otherOrganisation, [{ path: 'email', message: PARTNER_WORDS.otherOrganisation }]))).toBe('problem.otherOrganisation')
    expect((messagesFor('en', ['portal-access'])['portal-access'] as Record<string, string>)['problem.otherOrganisation']).toContain('another organisation')
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

// ---- F-SA-272 (sales page plan N5, pick P10'; the production lane's yes): the limits Apply no longer carries the supervisor ----
describe('F-SA-272: who looks after the customer moved to its Overview', () => {
  const saved = productionLimits({ version: 4 }).production
  const draft = { ...limitsDraftOf(saved), supervisorId: OFFICE_PEOPLE.bea.id, backupId: OFFICE_PEOPLE.carlo.id }

  it("Portal settings' Apply sends the limits only, even with a changed supervisor in the draft", async () => {
    const calls: string[] = []
    const outcome = await saveLimits(saved, { ...draft, level: 'PROGRESS' }, { limits: async () => (calls.push('limits'), productionLimits({ version: 5 })) }, { manage: true, supervise: false })
    expect(outcome).toEqual({ state: 'saved', limits: true, supervisor: false })
    expect(calls).toEqual(['limits'])
  })

  it("the Overview card's Apply sends the supervisor only, with the version read", async () => {
    const calls: string[] = []
    const outcome = await saveLimits(saved, draft, { supervisor: async (body) => (calls.push(`supervisor v${body.version} ${body.supervisorId}`), { version: 5 }) }, { manage: false, supervise: true })
    expect(outcome).toEqual({ state: 'saved', limits: false, supervisor: true })
    expect(calls).toEqual([`supervisor v4 ${OFFICE_PEOPLE.bea.id}`])
  })

  it('the limits card no longer draws the supervisor; the Overview\'s People does, office only (F-CO-201: rows + ONE Change… window)', () => {
    const card = readFileSync(new URL('./view/LimitsCard.tsx', import.meta.url), 'utf8')
    expect(card).not.toContain('function SupervisorBlock')
    const moved = readFileSync(new URL('./view/CustomerSupervisorCard.tsx', import.meta.url), 'utf8')
    expect(moved).toContain('function SupervisorBlock')
    expect(moved).toContain("t('limits.supervisor.officeOnly')")
    const draw = (id: string) => {
      const View = customerRecordScreen.view as ComponentType<{ model: unknown }>
      const item = (customerRecordScreen as DesignScreen<unknown>).cases.find((entry) => entry.id === id)!
      return renderToString(createElement(I18nProvider, { locale: 'en', messages: messagesFor('en', ['shell']) }, createElement(View, { model: item.model })))
    }
    // F-CO-201 (customer Overview, co-w2 W2.1; S10): People's rows — the supervisor named with "Office only", the backup; ONE Change…
    // (production.brand.manage) opens the window with the same form. The card under the People pair is gone.
    const html = draw('overview-supervisor')
    expect(html).toContain('Production supervisor')
    expect(html).toContain(OFFICE_PEOPLE.bea.name)
    expect(html).toContain(OFFICE_PEOPLE.carlo.name)
    expect(html).toContain('Office only')
    expect(html).not.toContain('Who looks after')
    expect(html.match(/Change…/g)?.length).toBe(1)
    // The form's words are its window's: its title names who looks after; the first pick says what it moves.
    const form = draw('overview-supervisor-new')
    expect(form).toContain('Who looks after')
    expect(form).toContain('Changing the supervisor moves')
    // Without production.brand.manage: the row stands, its Change… is not drawn (never held for a right).
    const held = draw('overview-supervisor-held')
    expect(held).toContain('Production supervisor')
    expect(held).not.toContain('Change…')
    expect(SUPERVISOR_CASES.first.draft?.supervisorId).toBe(OFFICE_PEOPLE.bea.id)
  })
})
// ---- end F-SA-272

// ---- F-CP-155 (customer page plan C7, D12, C5; design 10 §7, picture 23; review F1; lead picks: no step-up, made-to-measure drafts ON
// by default; the API's B-CP-078): the Factory designer + Backup rows on "Who looks after <customer>", ONE Change… window, refusals
// at the field, lost reach, the portal off, held without the right; the made-to-measure drafts switch on the Portal card.
describe('F-CP-155: the factory designer rows and the made-to-measure drafts switch', () => {
  const customer = 'Moda Demo'
  const drawCase = (id: string, locale: 'en' | 'it' = 'en') => {
    const View = customerRecordScreen.view as ComponentType<{ model: unknown }>
    const item = (customerRecordScreen as DesignScreen<unknown>).cases.find((entry) => entry.id === id)
    if (!item) throw new Error(id)
    return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(View, { model: item.model })))
  }
  const plain = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/\s+/g, ' ')

  it('the rows: each name with "<customer> sees this name", or why the portal no longer names them (they stay named until changed)', async () => {
    const { personTagOf, portalLineOf } = await import('./designer/model')
    const { designerSlot, DESIGNERS } = await import('./demo')
    expect(personTagOf({ state: 'OK' })).toEqual({ tone: 'info', words: { key: 'customers.designer.seen' } })
    expect(personTagOf({ state: 'NO_REACH' })).toEqual({ tone: 'warning', words: { key: 'customers.designer.lostReach' } })
    expect(personTagOf({ state: 'NOT_ACTIVE' })).toEqual({ tone: 'warning', words: { key: 'customers.designer.notActive' } })
    expect(portalLineOf(designerSlot())).toEqual({ key: 'customers.designer.hint' })
    expect(portalLineOf(designerSlot({ portalOn: false }))).toEqual({ key: 'customers.designer.portalOff' })
    const lost = designerSlot({ designer: { id: DESIGNERS.giulia.id, name: DESIGNERS.giulia.name, state: 'NO_REACH' } })
    expect(portalLineOf(lost)).toEqual({ key: 'customers.designer.backupNamed', params: { name: DESIGNERS.elena.name } })
    expect(portalLineOf({ ...lost, backup: { ...lost.backup!, state: 'NOT_ACTIVE' } })).toEqual({ key: 'customers.designer.nobodyNamed' })
    const html = plain(drawCase('overview-designer'))
    expect(html).toContain('Factory designer')
    expect(html).toContain('Giulia Verdi')
    expect(html).toContain('Elena Rossi')
    expect(html).toContain(`${customer} sees this name`)
    expect(html).toContain(`${customer} sees only this person's name when it asks for design help.`)
    // The supervisor keeps "Office only": the one difference a reader must see.
    expect(html).toContain('Office only')
    expect(plain(drawCase('overview-designer-lost'))).toContain(`No longer reaches ${customer}`)
    expect(plain(drawCase('overview-designer-lost'))).toContain('The portal now names the backup, Elena Rossi.')
    expect(plain(drawCase('overview-designer-portal-off'))).toContain(`${customer} has no portal yet: the name shows once the portal is on.`)
    expect(plain(drawCase('overview-designer-empty'))).toContain('Not set')
  })

  it('Change… held in words without the right (partners.manage), or not at every company the customer works with; no step-up', async () => {
    const { changeHeldOf } = await import('./designer/model')
    const { designerSlot } = await import('./demo')
    expect(changeHeldOf(false, { status: 'ready', slot: designerSlot() })).toEqual({ key: 'right.manage', ns: 'portal-access' })
    expect(changeHeldOf(true, { status: 'ready', slot: designerSlot({ mayManage: false }) })).toEqual({ key: 'customers.designer.heldEveryCompany' })
    expect(changeHeldOf(true, { status: 'ready', slot: designerSlot() })).toBeNull()
    const words = messagesFor('en', ['portal-access'])['portal-access']!
    expect(words['held.needs']).toBe('Needs the right: {right}.')
    expect(words['right.manage']).toBeTruthy()
    // No fresh code: the hook writes with the stored version and an Idempotency-Key only (a name, no money, no access).
    const hook = readFileSync(new URL('./designer/use-factory-designer.ts', import.meta.url), 'utf8')
    expect(hook).toContain('setFactoryDesigner(api, partyId, { ...open.draft, version: now.slot.version }, key.current ?? newIdempotencyKey())')
    expect(hook).not.toMatch(/guard\(|stepUp/)
  })

  it('ONE Change… window: the pick lists name only eligible office people (a named one no longer listed is said so); the backup never the designer', async () => {
    const { choicesOf, draftProblems, applyHeldOf, designerDraftOf } = await import('./designer/model')
    const { designerSlot, DESIGNERS, OFFICE_PEOPLE: PEOPLE } = await import('./demo')
    const choices = { people: [PEOPLE.me, DESIGNERS.elena], complete: true }
    const slot = designerSlot()
    expect(choicesOf(choices, slot.designer, null).map((entry) => entry.value)).toEqual([DESIGNERS.giulia.id, PEOPLE.me.id, DESIGNERS.elena.id])
    expect(choicesOf(choices, slot.designer, null)[0]!.label).toEqual({ key: 'customers.designer.notListed', params: { name: DESIGNERS.giulia.name } })
    expect(choicesOf(choices, slot.designer, null)[1]!.label).toEqual({ key: 'customers.designer.me', params: { name: PEOPLE.me.name } })
    expect(choicesOf(choices, slot.backup, DESIGNERS.elena.id).map((entry) => entry.value)).toEqual([PEOPLE.me.id])
    expect(draftProblems({ designerId: null, backupId: DESIGNERS.elena.id })).toEqual({ backupId: { key: 'customers.designer.refusal.BACKUP_ALONE' } })
    expect(draftProblems({ designerId: DESIGNERS.elena.id, backupId: DESIGNERS.elena.id })).toEqual({ backupId: { key: 'customers.designer.refusal.SAME_PERSON' } })
    expect(draftProblems({ designerId: DESIGNERS.giulia.id, backupId: null })).toEqual({})
    const open = { draft: designerDraftOf(slot), choices: { status: 'ready' as const, choices }, busy: false, fields: {}, problem: null }
    expect(applyHeldOf(open, slot)).toEqual({ key: 'customers.designer.nothing' })
    expect(applyHeldOf({ ...open, draft: { designerId: PEOPLE.me.id, backupId: null } }, slot)).toBeNull()
    expect(applyHeldOf({ ...open, busy: true }, slot)).toEqual({ key: 'customers.designer.saving' })
    expect(applyHeldOf({ ...open, choices: { status: 'loading' } }, slot)).toEqual({ key: 'customers.designer.reading' })
  })

  it('refusals at the field in the card\'s words (the API\'s English matched to its code, whatever the customer\'s spelling)', async () => {
    const { designerRefusalOf } = await import('./designer/model')
    const { DESIGNER_WORDS } = await import('@nexus/factory-domain/auth/partners/designer')
    const invalid = (path: string, message: string) => new ApiError('invalid', 400, 'validation_failed', message, 'req', [{ path, message }])
    expect(designerRefusalOf(invalid('body/designerId', DESIGNER_WORDS.NO_REACH.en.replace('{customer}', 'Moda Demo S.r.l.'))).fields).toEqual({ designerId: { key: 'customers.designer.refusal.NO_REACH' } })
    expect(designerRefusalOf(invalid('body/designerId', DESIGNER_WORDS.NOT_OFFICE.en)).fields).toEqual({ designerId: { key: 'customers.designer.refusal.NOT_OFFICE' } })
    expect(designerRefusalOf(invalid('body/backupId', DESIGNER_WORDS.SAME_PERSON.en)).fields).toEqual({ backupId: { key: 'customers.designer.refusal.SAME_PERSON' } })
    expect(designerRefusalOf(invalid('body/backupId', 'Something new.')).fields).toEqual({ backupId: { key: 'customers.designer.refusal.other' } })
    expect(designerRefusalOf(new ApiError('conflict', 409, 'conflict', 'stale', 'req', [{ path: 'version', message: 'The current version is 6.' }]))).toEqual({ fields: {}, problem: { key: 'customers.designer.stale' }, reread: true })
    // A customer out of reach: the neutral words of an unknown id (the brand wall), never a hint that it exists.
    expect(designerRefusalOf(new ApiError('not_found', 404, 'not_found', 'Customer not found.')).problem).toEqual({ key: 'customers.designer.notFound' })
    expect(messagesFor('en', ['parties']).parties!['customers.designer.notFound']).toBe('Customer not found.')
  })

  it('the made-to-measure drafts switch: on by default, saved with the Portal card (its version, a fresh code); customers only', () => {
    const saved = customerAccess().settings
    expect(settingsDraftOf(saved).mtmDraftsOn).toBe(true)
    expect(settingsDraftOf({ ...saved, mtmDraftsOn: false }).mtmDraftsOn).toBe(false)
    expect(settingsBody(saved, settingsDraftOf(saved))).toBeNull()
    expect(settingsBody(saved, { ...settingsDraftOf(saved), mtmDraftsOn: false })).toEqual({ version: saved.version, mtmDraftsOn: false })
    const view = readFileSync(new URL('./view/PortalAccessView.tsx', import.meta.url), 'utf8')
    expect(view).toContain("model.side === 'customers' && access.kinds.includes('CUSTOMER') && <MtmDraftsSwitch checked={draft.mtmDraftsOn ?? true} held={held}")
    const container = readFileSync(new URL('./PortalAccess.tsx', import.meta.url), 'utf8')
    expect(container).toContain("write('stepUp.sentence.settings', () => changeSettings(api, party.id, body, newIdempotencyKey())")
  })

  it('the design cases (light / dark, 1440 / 375 in the design index) and every word in both languages', () => {
    const ids = (customerRecordScreen as DesignScreen<unknown>).cases.map((entry) => entry.id)
    for (const id of ['overview-designer', 'overview-designer-change', 'overview-designer-refused', 'overview-designer-lost', 'overview-designer-portal-off', 'overview-designer-empty', 'overview-designer-held', 'overview-designer-every-company', 'overview-designer-loading', 'overview-designer-error']) expect(ids, id).toContain(id)
    expect(plain(drawCase('overview-designer-held'))).toContain('Factory designer')
    expect(plain(drawCase('overview-designer-error'))).toContain("Couldn't read the factory designer")
    for (const locale of ['it', 'en'] as const) {
      const words = messagesFor(locale, ['parties']).parties!
      for (const key of ['label', 'backup', 'none', 'seen', 'lostReach', 'notActive', 'hint', 'portalOff', 'backupNamed', 'nobodyNamed', 'change', 'title', 'backupHint', 'search', 'me', 'notListed', 'partial', 'nobodyEligible', 'apply', 'saving', 'reading', 'readFailed', 'choicesFailed', 'done', 'stale', 'nothing', 'fixFirst', 'failed', 'notFound', 'heldEveryCompany', 'refusal.NOT_OFFICE', 'refusal.NOT_ACTIVE', 'refusal.NO_REACH', 'refusal.BACKUP_ALONE', 'refusal.SAME_PERSON', 'refusal.other', 'mtm.label', 'mtm.onHint', 'mtm.offHint'])
        expect(words[`customers.designer.${key}`], `${locale} ${key}`).toBeTruthy()
      expect(plain(drawCase('overview-designer', locale)), locale).not.toMatch(/customers\.designer\./)
    }
    expect(messagesFor('it', ['parties']).parties!['customers.designer.seen']).toBe('{customer} vede questo nome')
  })
})
// ---- end F-CP-155

// ---- follow-up 14 (customer page lane, the money wall; the API's B-CP-011): Portal access says who gives a role that sees prices
describe('follow-up 14: Portal access says the Owner-only refusals in their own words', () => {
  const forbidden = (path: string) => new ApiError('forbidden', 403, 'forbidden', 'Only the Owner gives a role that sees prices.', 'r', [{ path, message: 'Only the Owner gives a role that sees prices.' }])

  it('inviting a guest Accountant, or giving its role, and a later end of its access: the Owner’s, never "role not offered" or "end of access"', () => {
    expect(partnerProblem(forbidden('roleKey/onlyOwnerGivesPrices'))).toBe('moneyWall.ownerGives')
    expect(partnerProblem(forbidden('accessUntil/onlyOwnerGivesPrices'))).toBe('moneyWall.ownerLater')
    expect(partnerProblem(new ApiError('forbidden', 403, 'forbidden', 'x', 'r', [{ path: ['roleKey', 'onlyOwnerGivesPrices'], message: 'x' }]))).toBe('moneyWall.ownerGives')
    // the field's own refusals keep their words
    expect(partnerProblem(new ApiError('invalid', 400, 'validation_failed', 'The access is not valid.', 'r', [{ path: 'roleKey', message: 'x' }]))).toBe('problem.roleNotOffered')
    expect(partnerProblem(new ApiError('invalid', 400, 'validation_failed', 'The access is not valid.', 'r', [{ path: 'accessUntil', message: 'x' }]))).toBe('problem.accessUntil')
  })

  it('the words are Finance › Close’s and the catalogue’s rule ("Who sees prices"), in Italian and English, never a key', () => {
    for (const locale of ['it', 'en'] as const) {
      const access = messagesFor(locale, ['portal-access'])['portal-access'] as Record<string, string>
      const accountant = messagesFor(locale, ['portal-accountant'])['portal-accountant'] as Record<string, string>
      const security = messagesFor(locale, ['admin-security'])['admin-security'] as Record<string, string>
      expect(access['moneyWall.ownerGives'], locale).toBe(accountant['moneyWall.ownerGives'])
      expect(access['moneyWall.ownerLater'], locale).toBe(accountant['moneyWall.ownerLater'])
      expect(access['moneyWall.ownerGives'], locale).toBe(security['sec.priceHolders.hint'])
    }
    expect((messagesFor('en', ['portal-access'])['portal-access'] as Record<string, string>)['moneyWall.ownerGives']).toBe('Only the Owner gives a role that sees prices.')
    expect((messagesFor('it', ['portal-access'])['portal-access'] as Record<string, string>)['moneyWall.ownerGives']).toBe('Solo il titolare dà un ruolo che vede i prezzi.')
  })
})
// ---- end follow-up 14

// ---- B-CP-011 (follow-up 15, the money wall; Owner O3): Portal access holds a role only the Owner gives BEFORE the click — the API's
// read says which role (`roles[].ownerGives`: a guest's role that sees prices, the Accountant) and whether the reader gives it
// (`mayGivePriceRole`: true only for the Owner); the words are the 403's; the 403 stays the API's wall.
describe('follow-up 15: Portal access holds a role only the Owner gives before the click, in the 403’s words', () => {
  const guestAccess = (over: Partial<PortalAccess> = {}): PortalAccess =>
    customerAccess({
      party: { ...customerAccess().party, id: '0190f0e2-1000-7000-8000-000000000021', code: 'STUDIO-ESEMPIO', name: 'Studio Esempio', roles: ['CONSULTANT'] },
      kinds: ['GUEST'],
      roles: rolesOf(['GUEST']).map((role) => ({ ...role, ownerGives: true })),
      people: [],
      seats: { taken: 0, max: null },
      mayGivePriceRole: false,
      ...over,
    })
  // The API's answer for a customer: no role is the Owner's (its Buyer sees its own orders' prices and Sales gives it, O4).
  const customerRead = (mayGivePriceRole: boolean) => customerAccess({ roles: rolesOf(['CUSTOMER']).map((role) => ({ ...role, ownerGives: false })), mayGivePriceRole })
  const anna: PartnerPerson = { ...marco, id: '0190f0e2-a180-7000-8000-000000000071', displayName: 'Anna Conti', email: 'anna.conti@studio-esempio.example', kind: 'GUEST', roleKey: 'guest-accountant', roleName: 'Accountant', seesPrices: true, capabilities: ['comment'], accessUntil: endOfDay('2026-11-30'), version: 2 }
  const accountant = () => guestAccess().roles.find((role) => role.key === 'guest-accountant')!

  it('a role is held only when the read says the Owner gives it and the reader is not the Owner; an older answer holds nothing', () => {
    expect(accountant()).toMatchObject({ kind: 'GUEST', seesPrices: true, ownerGives: true })
    expect(roleHeld(accountant(), { mayGivePriceRole: false })).toBe('moneyWall.ownerGives')
    expect(roleHeld(accountant(), { mayGivePriceRole: true })).toBeNull()
    expect(roleHeld(accountant(), {})).toBeNull()
    expect(roleHeld({ ownerGives: undefined }, { mayGivePriceRole: false })).toBeNull()
    // A customer's Buyer sees prices, yet it is not the Owner's to give: never held for Sales.
    const buyer = customerRead(false).roles.find((role) => role.key === 'customer-buyer')!
    expect(buyer.seesPrices).toBe(true)
    expect(roleHeld(buyer, customerRead(false))).toBeNull()
  })

  it('Invite says it before the click for an adviser’s portal (only the Accountant), after the right; never for a customer’s', () => {
    expect(inviteHeld(guestAccess(), ALL_RIGHTS)).toBe('moneyWall.ownerGives')
    expect(inviteHeld(guestAccess(), READ_ONLY)).toBe('right.invite')
    expect(inviteHeld(guestAccess({ mayGivePriceRole: true }), ALL_RIGHTS)).toBeNull()
    expect(inviteHeld(guestAccess({ mayGivePriceRole: undefined }), ALL_RIGHTS)).toBeNull()
    expect(inviteHeld(customerRead(false), ALL_RIGHTS)).toBeNull()
    // A customer that is also an adviser: its customer people are still Sales' to invite.
    const both = guestAccess({ kinds: ['CUSTOMER', 'GUEST'], roles: [...customerRead(false).roles, accountant()] })
    expect(inviteHeld(both, ALL_RIGHTS)).toBeNull()
    expect(firstRole(both, 'CUSTOMER')?.key).toBe('customer-buyer')
    expect(firstRole(both, 'GUEST')).toBeUndefined()
  })

  it('the invite never starts on a role the reader cannot give; choosing it anyway is held in the 403’s words', () => {
    const blank = blankInvite(guestAccess())
    expect(blank).toMatchObject({ kind: 'GUEST', roleKey: '', capabilities: [] })
    const typed = { ...blank, name: 'Anna Conti', email: 'anna.conti@studio-esempio.example', until: '2026-12-31' }
    expect(inviteProblems(typed, guestAccess(), DEMO_TODAY)).toEqual({ roleKey: 'moneyWall.ownerGives' })
    expect(inviteProblems({ ...typed, roleKey: 'guest-accountant', capabilities: ['comment'] }, guestAccess(), DEMO_TODAY)).toEqual({ roleKey: 'moneyWall.ownerGives' })
    // The Owner: the Accountant is the first role, nothing held.
    const owners = guestAccess({ mayGivePriceRole: true })
    expect(blankInvite(owners)).toMatchObject({ kind: 'GUEST', roleKey: 'guest-accountant', capabilities: ['comment'] })
    expect(inviteProblems({ ...blankInvite(owners), name: 'Anna Conti', email: 'anna.conti@studio-esempio.example', until: '2026-12-31' }, owners, DEMO_TODAY)).toEqual({})
    // A customer: Sales still starts on the Buyer (it sees prices; not the Owner's to give) with nothing held.
    expect(blankInvite(customerRead(false))).toMatchObject({ kind: 'CUSTOMER', roleKey: 'customer-buyer' })
    expect(inviteProblems({ ...blankInvite(customerRead(false)), name: 'Nadia', email: 'nadia@example.com' }, customerRead(false), DEMO_TODAY)).toEqual({})
  })

  it('an Accountant’s access: a new role or capability and a later end are the Owner’s (held in words); an earlier end stays free', () => {
    const access = guestAccess({ people: [anna] })
    const draft = personDraftOf(anna)
    expect(draft).toEqual({ roleKey: 'guest-accountant', capabilities: ['comment'], until: '2026-11-30' })
    expect(personProblems(draft, anna, DEMO_TODAY, access)).toEqual({})
    expect(personProblems({ ...draft, capabilities: [] }, anna, DEMO_TODAY, access)).toEqual({ roleKey: 'moneyWall.ownerGives' })
    expect(personProblems({ ...draft, until: '2026-12-15' }, anna, DEMO_TODAY, access)).toEqual({ until: 'moneyWall.ownerLater' })
    expect(personProblems({ ...draft, until: '2026-11-15' }, anna, DEMO_TODAY, access)).toEqual({})
    // The Owner moves it as before; without the read's answer nothing is held (the API's 403 says it, partnerProblem).
    const owners = guestAccess({ people: [anna], mayGivePriceRole: true })
    expect(personProblems({ ...draft, capabilities: [], until: '2026-12-15' }, anna, DEMO_TODAY, owners)).toEqual({})
    expect(personProblems({ ...draft, until: '2026-12-15' }, anna, DEMO_TODAY)).toEqual({})
    // A customer's Buyer: Sales changes the role as before.
    expect(personProblems({ ...personDraftOf(marco), roleKey: 'customer-finance' }, marco, DEMO_TODAY, customerRead(false))).toEqual({})
  })

  it('the dialogs pass the hold to every role card; the person’s own role is never said held', () => {
    const source = readFileSync(new URL('./view/PortalDialogs.tsx', import.meta.url), 'utf8')
    expect(source).toContain('heldOf={(entry) => roleHeld(entry, access)}')
    expect(source).toContain('heldOf={(entry) => (entry.key === person.roleKey ? null : roleHeld(entry, access))}')
    expect(source).toContain('onChange={() => (held ? undefined : onChange(role))}')
    expect(source).toContain('personProblems(draft, person, model.today, access)')
    expect(source).toContain('const first = firstRole(access, kind)')
  })
})
// ---- end B-CP-011 follow-up 15

// ---- L5 (cp-fx14; customer page walk; #1767 follow-up 15): SCR-033-portal has the design cases of the role only the Owner gives —
// an adviser's portal read by Sales (the guest Accountant held in the 403's words, Invite held) and by the Owner (it can be picked).
import { designScreen as portalScreen } from './fixtures'
import { createTranslator } from '../../../../lib/i18n/messages'
import type { PortalAccessModel } from './model'

describe('walk L5: SCR-033-portal — an adviser’s portal: Sales sees the Accountant held in the 403’s words, the Owner picks it', () => {
  const screen = portalScreen as DesignScreen<PortalAccessModel>
  const caseOf = (id: string): PortalAccessModel => {
    const item = screen.cases.find((entry) => entry.id === id)
    if (!item) throw new Error(id)
    return item.model
  }
  const drawCase = (id: string, locale: 'en' | 'it') => {
    const View = screen.view as ComponentType<{ model: PortalAccessModel }>
    return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(View, { model: caseOf(id) })))
  }
  const ownerGivesWords = (locale: 'en' | 'it') => createTranslator(locale, messagesFor(locale, ['portal-access'])['portal-access'] ?? {})('moneyWall.ownerGives')
  const accountantOf = (access: PortalAccess) => access.roles.find((role) => role.key === 'guest-accountant')!

  it('Sales on an adviser’s portal: Invite held before the click in the 403’s words (it + en); the page is the adviser’s alone', () => {
    const sales = caseOf('cp-1767-adviser-sales')
    expect(sales.access!.kinds).toEqual(['GUEST'])
    expect(sales.access!.mayGivePriceRole).toBe(false)
    expect(accountantOf(sales.access!)).toMatchObject({ kind: 'GUEST', seesPrices: true, ownerGives: true })
    expect(inviteHeld(sales.access!, sales.can)).toBe('moneyWall.ownerGives')
    expect(ownerGivesWords('en')).toBe('Only the Owner gives a role that sees prices.')
    for (const locale of ['en', 'it'] as const) {
      const html = drawCase('cp-1767-adviser-sales', locale)
      expect(html, locale).toContain(ownerGivesWords(locale))
      expect(html, locale).toContain('Studio Esempio')
      // One party per page: never Moda Demo's name, people or requests on the adviser's page (the record, the tab, the thread).
      expect(html, locale).not.toMatch(/Moda Demo|Marco Prova|Sara Demo/)
    }
  })

  it('Sales inviting on a customer that is also an adviser: the guest Accountant card held, never taken; the Owner picks it', () => {
    const invite = caseOf('cp-1767-adviser-sales-invite')
    const access = invite.access!
    expect(access.kinds).toEqual(['CUSTOMER', 'GUEST'])
    expect(inviteHeld(access, invite.can)).toBeNull()
    expect(roleHeld(accountantOf(access), access)).toBe('moneyWall.ownerGives')
    expect(invite.dialog).toEqual({ kind: 'invite' })
    expect(invite.inviteDraft).toMatchObject({ kind: 'GUEST', roleKey: '' })
    expect(inviteProblems(invite.inviteDraft!, access, DEMO_TODAY)).toMatchObject({ roleKey: 'moneyWall.ownerGives' })
    expect(firstRole(access, 'GUEST')).toBeUndefined()
    expect(firstRole(access, 'CUSTOMER')?.key).toBe('customer-buyer')

    const owner = caseOf('cp-1767-adviser-owner')
    expect(owner.access!.mayGivePriceRole).toBe(true)
    expect(inviteHeld(owner.access!, owner.can)).toBeNull()
    expect(roleHeld(accountantOf(owner.access!), owner.access!)).toBeNull()
    expect(owner.inviteDraft).toMatchObject({ kind: 'GUEST', roleKey: 'guest-accountant' })
    expect(inviteProblems(owner.inviteDraft!, owner.access!, DEMO_TODAY)).toEqual({})
    for (const locale of ['en', 'it'] as const) expect(drawCase('cp-1767-adviser-owner', locale), locale).not.toContain(ownerGivesWords(locale))
  })
})
// ---- end L5

// ---- F-CA-fx3 (P0-B1): the address `?invite=` opens the invitation only for who may invite (imported here, below the lines above)
import { partnerCan } from '../../../admin/users/partners/model'

describe('F-CA-fx3 (P0-B1): `?invite=` opens the invitation only for who may invite — the in-page Invite button\'s own right', () => {
  it('a reader without partners.invite gets no window from the address; with the right the window is the same as before, filled in', () => {
    // The right the in-page Invite button reads (PeopleCard: inviteHeld(access, model.can)) — partners.invite, no new right.
    expect(partnerCan(['partners.view']).invite).toBe(false)
    expect(inviteHeld(customerAccess(), partnerCan(['partners.view']))).toBe('right.invite')
    expect(partnerCan(['partners.view', 'partners.invite']).invite).toBe(true)
    expect(inviteHeld(customerAccess(), READ_ONLY)).toBe('right.invite')
    const container = readFileSync(new URL('./PortalAccess.tsx', import.meta.url), 'utf8')
    expect(container).toContain('const can = useMemo(() => partnerCan(session.permissions), [session.permissions])')
    const start = container.indexOf('const invited = useRef(false)')
    expect(start).toBeGreaterThan(-1)
    const effect = container.slice(start, container.indexOf('// ---- end F-SA-274', start))
    // F-CA-fx5 (walk W-11; pin moved, same strictness): the address door is read once the people are read (by a mount that draws them),
    // marks itself used, and opens the window ONLY with the right — checked right before the window, never after it opens.
    const guard = "if (invited.current || left === null || !access || !(parts ?? PORTAL_PARTS).includes('people')) return"
    expect(effect).toContain(guard)
    expect(effect.indexOf(guard)).toBeLessThan(effect.indexOf('invited.current = true'))
    const opens = "if (can.invite && email) setDialog({ kind: 'invite', email, ...(search?.get('inviteName') ? { name: search.get('inviteName')! } : {}) })"
    expect(effect.indexOf('invited.current = true')).toBeLessThan(effect.indexOf(opens))
    // With the right: the same window as before (its e-mail and name from the address).
    expect(effect).toContain(opens)
    expect(effect.match(/setDialog\(/g)).toHaveLength(1)
    // The address is the container's only door that opens the invitation by itself (the button and People's ⋯ hand it to onDialog).
    expect(container.match(/setDialog\(\{ kind: 'invite'/g)).toHaveLength(1)
  })
})
// ---- end F-CA-fx3

// ---- F-CA-fx5 (customer People & addresses, walk W-11): `?invite=` is read once, then the address leaves it — with or without the right
import { INVITE_PARAMS, queryWithoutInvite } from './model'

describe('F-CA-fx5 (walk W-11): the address leaves `?invite=` (and `inviteName`) once it was read, as People\'s `&add=`', () => {
  it('the query keeps everything else; an address that asks nothing is left as it is (null)', () => {
    expect([...INVITE_PARAMS]).toEqual(['invite', 'inviteName'])
    expect(queryWithoutInvite('tab=people&invite=walk.check%40example.com&inviteName=Seed+Buyer')).toBe('tab=people')
    expect(queryWithoutInvite('tab=people&add=contact&invite=walk.check%40example.com')).toBe('tab=people&add=contact')
    expect(queryWithoutInvite('invite=')).toBe('')
    expect(queryWithoutInvite('tab=people&inviteName=Seed+Buyer')).toBe('tab=people')
    expect(queryWithoutInvite('tab=people&add=address')).toBeNull()
    expect(queryWithoutInvite('')).toBeNull()
  })

  it('the portal hook drops it for every reader once the people are read — the window only with the right; Portal settings reads nothing', () => {
    const container = readFileSync(new URL('./PortalAccess.tsx', import.meta.url), 'utf8')
    const start = container.indexOf('const invited = useRef(false)')
    const effect = container.slice(start, container.indexOf('// ---- end F-SA-274', start))
    expect(effect).toContain("const left = queryWithoutInvite(search?.toString() ?? '')")
    // Not refused by the right any more: a reader without partners.invite reads it too (no window), so the address leaves it for both.
    expect(effect).not.toMatch(/!can\.invite\b/)
    const leaves = "router.replace(`${pathname}${left ? `?${left}` : ''}${typeof window === 'undefined' ? '' : window.location.hash}`, { scroll: false })"
    expect(effect).toContain(leaves)
    expect(effect.indexOf('invited.current = true')).toBeLessThan(effect.indexOf(leaves))
    expect(effect.match(/router\.replace\(/g)).toHaveLength(1)
    // A mount that does not draw the people (the customer's Portal settings, the requests window) returns before it: as before.
    const record = readFileSync(new URL('../record/CustomerRecord.tsx', import.meta.url), 'utf8')
    expect(record).toContain("const PORTAL_SETTINGS_PARTS: readonly PortalPart[] = ['settings', 'preview', 'limits', 'requests']")
    expect(readFileSync(new URL('../record/view/WaitingForCustomerDialog.tsx', import.meta.url), 'utf8')).toContain("parts={['requests']}")
  })

  it('a People reader without the portal (no partners.view: no portal read) loses it at the arrival, with `&add=`', () => {
    const tab = readFileSync(new URL('../record/people/use-people-tab.ts', import.meta.url), 'utf8')
    expect(tab).toContain("const left = can.portal ? null : queryWithoutInvite(search?.toString() ?? '')")
    expect(tab).toContain('if (add || left !== null) {')
    expect(tab).toContain("const next = new URLSearchParams(left ?? search?.toString() ?? '')")
    expect(tab).toContain("next.delete('add')")
  })
})
// ---- end F-CA-fx5
