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

  it('the limits card no longer draws the supervisor; the Overview card does, office only', () => {
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
    const html = draw('overview-supervisor')
    expect(html).toContain('Who looks after')
    expect(html).toContain(OFFICE_PEOPLE.bea.name)
    expect(html).toContain('Office only')
    expect(draw('overview-supervisor-held')).toContain('Who looks after')
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
