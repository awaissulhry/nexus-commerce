import { PARTNER_PEOPLE, PARTNER_WORDS } from '@nexus/factory-domain/auth/partners/rules'
import { isApiError, issuePath } from '../../../../lib/api/errors'
import { DEFAULT_TIME_ZONE } from '../../../../lib/i18n/format'
import type { LiveChange } from '../../../../shell/live/use-live'
import type { User } from '../../shared/api'
import { matches } from '../../shared/model'
import { reachOf, type BulkReach } from '../../shared/reach'
import type { Capability, ChangeBody, InviteBody, Organisation, PartnerKind, PartnerPerson, PartnerRole, PersonAction, PortalAccess, PortalSettings, Seats, SettingsBody } from './api'

/**
 * Partner organisations in the office (B-W2b-180; PLT-006, PLT-021, PLT-022, SAL-060, SCM-092; design sales.customers and
 * purchasing.suppliers › Portal access, admin.users "Partners" and User › Partner organisation). Pure: the days of an end
 * of access in the site's zone, what each action reaches and why it is held, the invite, change and settings drafts, the
 * refusals in words (catalogue `portal-access`), the preview's address, which live events concern a party, and the
 * Partners list of Admin › Users. Partners never see more than prices (a yes/no per role); no money here.
 */

export const NS = 'portal-access'

// ---- days in the site's zone --------------------------------------------------------------------------------------------

function partsIn(instant: Date, timeZone: string): Record<string, number> {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(instant)
  return Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]))
}

/** The day ('YYYY-MM-DD') an instant falls on in the site's zone. */
export function dayOf(instant: string | Date, timeZone = DEFAULT_TIME_ZONE): string {
  const p = partsIn(new Date(instant), timeZone)
  return `${String(p.year).padStart(4, '0')}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`
}

/** The last second of a day in the site's zone, as an instant (an end of access chosen as a day lasts the whole day). */
export function endOfDay(day: string, timeZone = DEFAULT_TIME_ZONE): string {
  const wall = Date.parse(`${day}T23:59:59.000Z`)
  const p = partsIn(new Date(wall), timeZone)
  const offset = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - wall
  const first = wall - offset
  // Across a clock change the offset of the answer can differ from the guess's: correct once with the answer's own.
  const q = partsIn(new Date(first), timeZone)
  const again = Date.UTC(q.year, q.month - 1, q.day, q.hour, q.minute, q.second) - first
  return new Date(wall - again).toISOString()
}

export const addDays = (day: string, count: number): string => new Date(Date.parse(`${day}T12:00:00.000Z`) + count * 86_400_000).toISOString().slice(0, 10)

/** "Access ends soon": an end within 7 days (factory-domain PARTNER_PEOPLE, the API's tile). */
export function endsSoon(accessUntil: string | null | undefined, now: Date): boolean {
  if (!accessUntil) return false
  const left = Date.parse(accessUntil) - now.getTime()
  return left > 0 && left <= PARTNER_PEOPLE.accessEndingNoticeMs
}

/** The access ended (the API refuses the person by itself; the row still shows until deactivated). */
export const accessEnded = (accessUntil: string | null | undefined, now: Date): boolean => !!accessUntil && Date.parse(accessUntil) <= now.getTime()

// ---- the people of a party --------------------------------------------------------------------------------------------

export const STATUS_TONE: Readonly<Record<PartnerPerson['status'], 'success' | 'info' | 'warning' | 'neutral'>> = { ACTIVE: 'success', INVITED: 'info', SUSPENDED: 'warning', DEACTIVATED: 'neutral' }

/** The people of the tab: active, invited and suspended first (by name); the deactivated ones only when asked. */
export function peopleRows(people: readonly PartnerPerson[], showLeft: boolean): PartnerPerson[] {
  const rank = { ACTIVE: 0, INVITED: 1, SUSPENDED: 2, DEACTIVATED: 3 } as const
  return people.filter((person) => showLeft || person.status !== 'DEACTIVATED').sort((a, b) => rank[a.status] - rank[b.status] || a.displayName.localeCompare(b.displayName))
}

/** The admins of the party's portals (design User › Partner organisation: "its admin"). */
export const adminsOf = (people: readonly PartnerPerson[], kind?: PartnerKind | null) => people.filter((person) => person.admin && person.status === 'ACTIVE' && (!kind || person.kind === kind))

export interface PartnerCan {
  view: boolean
  invite: boolean
  manage: boolean
  preview: boolean
  /** partners.tasks.manage: ask the party for something, cancel a request. */
  requests: boolean
}

export const NO_PARTNER_RIGHTS: PartnerCan = { view: false, invite: false, manage: false, preview: false, requests: false }

export function partnerCan(permissions: readonly string[]): PartnerCan {
  const held = new Set(permissions)
  return { view: held.has('partners.view'), invite: held.has('partners.invite'), manage: held.has('partners.manage'), preview: held.has('partners.preview'), requests: held.has('partners.tasks.manage') }
}

export type RowAction = PersonAction | 'resend' | 'revoke'

/**
 * What an action over the ticked people reaches (the API's status machine): suspend the active, reactivate the suspended,
 * deactivate anyone not deactivated yet (an invited person's invitation stops with it), send the invitation again to the
 * invited. `held` is a key of `portal-access` (`right.…` = a right the person lacks).
 */
export function personReach(action: RowAction, selected: readonly PartnerPerson[], can: PartnerCan): BulkReach<PartnerPerson> {
  const manage = can.manage ? null : 'right.manage'
  const invite = can.invite ? null : 'right.invite'
  if (action === 'suspend') return reachOf(selected, (person) => person.status === 'ACTIVE', { held: manage, none: 'held.suspendNone' })
  if (action === 'reactivate') return reachOf(selected, (person) => person.status === 'SUSPENDED', { held: manage, none: 'held.reactivateNone' })
  if (action === 'deactivate') return reachOf(selected, (person) => person.status === 'ACTIVE' || person.status === 'SUSPENDED', { held: manage, none: 'held.deactivateNone' })
  if (action === 'revoke') return reachOf(selected, (person) => person.status === 'INVITED' && person.invitation !== null, { held: invite, none: 'held.revokeNone' })
  return reachOf(selected, (person) => person.status === 'INVITED', { held: invite, none: 'held.resendNone' })
}

/** Why a row cannot be ticked at all (nothing could act on it): a deactivated person. */
export const rowHeld = (person: PartnerPerson): string | null => (person.status === 'DEACTIVATED' ? 'held.left' : null)

/** The roles a person of this kind may get: the offered main roles of the kind (the admin last). */
export function roleChoices(roles: readonly PartnerRole[], kind: PartnerKind | null, current?: string | null): PartnerRole[] {
  return roles.filter((role) => role.kind === kind && (role.offered || role.key === current)).sort((a, b) => Number(a.admin) - Number(b.admin))
}

/** The seats left before the limit (null: no limit). */
export const seatsLeft = (seats: Seats): number | null => (seats.max === null ? null : Math.max(0, seats.max - seats.taken))

/**
 * Why Invite is held, in order: the right; the portal has no kind (not a customer, brand, supplier, workshop or adviser);
 * the party is blocked or archived; the company's portal terms are not published (GATE-PRIVACY); the seats are full.
 */
export function inviteHeld(access: PortalAccess, can: PartnerCan): string | null {
  if (!can.invite) return 'right.invite'
  if (access.kinds.length === 0) return 'held.noKind'
  if (access.party.status === 'BLOCKED' || access.party.status === 'ARCHIVED') return 'held.blocked'
  if (access.termsInForce === false) return 'held.noTerms'
  if (seatsLeft(access.seats) === 0) return 'held.seatsFull'
  return null
}

/** Why Preview is held: the right; a party with no portal kind. */
export function previewHeld(access: Pick<PortalAccess, 'kinds'> | null, can: PartnerCan): string | null {
  if (!can.preview) return 'right.preview'
  if (access && access.kinds.length === 0) return 'held.noKind'
  return null
}

// ---- invite ------------------------------------------------------------------------------------------------------------

export interface PartnerInviteDraft {
  name: string
  email: string
  kind: PartnerKind | null
  roleKey: string
  capabilities: Capability[]
  /** The last day of access ('YYYY-MM-DD'), or '' for none. */
  until: string
  locale: 'it' | 'en'
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** A blank invite: the party's only portal, its first offered role that is not the admin, that role's capabilities. */
export function blankInvite(access: Pick<PortalAccess, 'kinds' | 'roles'>, locale: 'it' | 'en' = 'it'): PartnerInviteDraft {
  const kind = access.kinds.length === 1 ? access.kinds[0]! : null
  const role = roleChoices(access.roles, kind).find((entry) => !entry.admin) ?? roleChoices(access.roles, kind)[0]
  return { name: '', email: '', kind, roleKey: role?.key ?? '', capabilities: role ? [...role.capabilities.byDefault] : [], until: '', locale }
}

/** The capabilities a role allows, kept from a choice when the role changes (a role that does not allow one drops it). */
export function capabilitiesFor(role: PartnerRole | undefined, chosen: readonly Capability[], fresh: boolean): Capability[] {
  if (!role) return []
  if (fresh) return [...role.capabilities.byDefault]
  return chosen.filter((capability) => role.capabilities.allowed.includes(capability))
}

/** Field → key of `portal-access`. `today` is the site's day; an end of access is a day after it, or none (not a guest). */
export function inviteProblems(draft: PartnerInviteDraft, access: Pick<PortalAccess, 'kinds' | 'roles' | 'people'>, today: string): Record<string, string> {
  const out: Record<string, string> = {}
  if (draft.name.trim() === '') out.name = 'form.required'
  const email = draft.email.trim().toLowerCase()
  if (!EMAIL.test(email)) out.email = 'form.email'
  else if (access.people.some((person) => person.email.toLowerCase() === email && person.status !== 'DEACTIVATED')) out.email = 'invite.exists'
  if (access.kinds.length > 1 && !draft.kind) out.kind = 'invite.kindNeeded'
  const role = access.roles.find((entry) => entry.key === draft.roleKey && entry.kind === draft.kind)
  if (!role) out.roleKey = 'invite.roleNeeded'
  else if (!role.offered) out.roleKey = 'invite.roleNotOffered'
  if (draft.until === '') {
    if (draft.kind === 'GUEST') out.until = 'invite.guestNeedsEnd'
  } else if (draft.until <= today) out.until = 'invite.untilFuture'
  return out
}

export function inviteBody(draft: PartnerInviteDraft): InviteBody {
  return {
    email: draft.email.trim(),
    displayName: draft.name.trim(),
    locale: draft.locale,
    ...(draft.kind ? { kind: draft.kind } : {}),
    roleKey: draft.roleKey,
    capabilities: [...draft.capabilities],
    accessUntil: draft.until ? endOfDay(draft.until) : null,
  }
}

// ---- change a person ---------------------------------------------------------------------------------------------------

export interface PersonDraft {
  roleKey: string
  capabilities: Capability[]
  until: string
}

export const personDraftOf = (person: PartnerPerson): PersonDraft => ({ roleKey: person.roleKey ?? '', capabilities: [...person.capabilities], until: person.accessUntil ? dayOf(person.accessUntil) : '' })

export function personProblems(draft: PersonDraft, person: PartnerPerson, today: string): Record<string, string> {
  const out: Record<string, string> = {}
  if (draft.roleKey === '') out.roleKey = 'invite.roleNeeded'
  if (draft.until === '') {
    if (person.kind === 'GUEST') out.until = 'invite.guestNeedsEnd'
  } else if (draft.until <= today && draft.until !== personDraftOf(person).until) out.until = 'invite.untilFuture'
  return out
}

/** Only what changes, with the version read; null: nothing changes. */
export function personBody(person: PartnerPerson, draft: PersonDraft): ChangeBody | null {
  const before = personDraftOf(person)
  const body: ChangeBody = { version: person.version }
  if (draft.roleKey !== before.roleKey) body.roleKey = draft.roleKey
  if ([...draft.capabilities].sort().join() !== [...before.capabilities].sort().join()) body.capabilities = [...draft.capabilities]
  if (draft.until !== before.until) body.accessUntil = draft.until ? endOfDay(draft.until) : null
  return Object.keys(body).length === 1 ? null : body
}

// ---- the portal's settings ---------------------------------------------------------------------------------------------

export interface SettingsDraft {
  portalOn: boolean
  progressShared: boolean
  /** People at most, as typed ('' = no limit). */
  maxUsers: string
  /** The roles the portal offers ([] = every role of its kinds). */
  allowedRoleKeys: string[]
}

export const settingsDraftOf = (settings: PortalSettings): SettingsDraft => ({ portalOn: settings.portalOn, progressShared: settings.progressShared, maxUsers: settings.maxUsers === null ? '' : String(settings.maxUsers), allowedRoleKeys: [...settings.allowedRoleKeys] })

export function settingsProblems(draft: SettingsDraft, seats: Seats): Record<string, string> {
  const out: Record<string, string> = {}
  if (draft.maxUsers.trim() !== '') {
    const value = Number(draft.maxUsers)
    if (!Number.isInteger(value) || value < 1 || value > 1000) out.maxUsers = 'settings.maxRange'
    else if (value < seats.taken) out.maxUsers = 'settings.maxBelowTaken'
  }
  return out
}

/** Only what changes, with the version read (0: no settings row yet); null: nothing changes. */
export function settingsBody(saved: PortalSettings, draft: SettingsDraft): SettingsBody | null {
  const before = settingsDraftOf(saved)
  const body: SettingsBody = { version: saved.version }
  if (draft.portalOn !== before.portalOn) body.portalOn = draft.portalOn
  if (draft.progressShared !== before.progressShared) body.progressShared = draft.progressShared
  if (draft.maxUsers.trim() !== before.maxUsers) body.maxUsers = draft.maxUsers.trim() === '' ? null : Number(draft.maxUsers)
  if ([...draft.allowedRoleKeys].sort().join() !== [...before.allowedRoleKeys].sort().join()) body.allowedRoleKeys = [...draft.allowedRoleKeys]
  return Object.keys(body).length === 1 ? null : body
}

/** The production-progress switch is only a customer's or a brand's (Owner answer C1). */
export const progressApplies = (kinds: readonly PartnerKind[]) => kinds.includes('CUSTOMER')

// ---- refusals in words -------------------------------------------------------------------------------------------------

const CONFLICTS: ReadonlyArray<[string, string]> = [
  [PARTNER_WORDS.blocked, 'problem.blocked'],
  [PARTNER_WORDS.officeAddress, 'problem.officeAddress'],
  [PARTNER_WORDS.otherOrganisation, 'problem.otherOrganisation'],
  [PARTNER_WORDS.alreadyIn, 'problem.alreadyIn'],
  [PARTNER_WORDS.rolesNotReady, 'problem.rolesNotReady'],
  [PARTNER_WORDS.noKind, 'problem.noKind'],
  [PARTNER_WORDS.notInvited, 'problem.notInvited'],
  [PARTNER_WORDS.stillInvited, 'problem.stillInvited'],
  [PARTNER_WORDS.noPortalCompany, 'problem.noPortalCompany'],
  [PARTNER_WORDS.progressOnlyCustomers, 'problem.progressOnlyCustomers'],
]

/**
 * A refused partner call as a key of `portal-access`: the rule's own sentence when the API said one of factory-domain's
 * PARTNER_WORDS (the same constants), the seats limit, a field the API named, else the kind of refusal. Never the API's
 * English.
 */
export function partnerProblem(error: unknown): string {
  if (!isApiError(error)) return 'problem.internal'
  const known = CONFLICTS.find(([words]) => error.message === words)
  if (known) return known[1]
  if (error.message.startsWith('The portal of ') && error.message.includes(' at most ')) return 'problem.seatsFull'
  // apps/factory-api platform/auth/portal/terms.ts PORTAL_TERMS_MISSING (GATE-PRIVACY: no invitation before the terms).
  if (error.message.startsWith('The portal terms of this company are not published yet')) return 'problem.noTerms'
  const path = error.issues.map(issuePath).find((value) => value !== '') ?? ''
  if (/roleKey/.test(path)) return 'problem.roleNotOffered'
  if (/accessUntil/.test(path)) return 'problem.accessUntil'
  if (/capabilities/.test(path)) return 'problem.capability'
  if (/email/.test(path)) return 'problem.email'
  if (/companyId/.test(path)) return 'problem.noPortalCompany'
  switch (error.kind) {
    case 'signed_out':
      return 'problem.signedOut'
    case 'forbidden':
      return 'problem.forbidden'
    case 'step_up':
      return 'problem.stepUp'
    case 'not_found':
      return 'problem.notFound'
    case 'conflict':
      return 'problem.conflict'
    case 'invalid':
      return 'problem.invalid'
    case 'rate_limited':
      return 'problem.rateLimited'
    case 'unavailable':
      return 'problem.unavailable'
    case 'contract':
      return 'problem.contract'
    default:
      return 'problem.internal'
  }
}

// ---- the preview -------------------------------------------------------------------------------------------------------

/** Where the preview opens: the party's portal Home, or one record of it through the frame's record route. */
export function portalAddress(partyCode: string, record?: { type: string; id: string } | null): string {
  const home = `/p/${encodeURIComponent(partyCode)}`
  return record ? `${home}/open/${encodeURIComponent(record.type)}/${encodeURIComponent(record.id)}` : home
}

// ---- live --------------------------------------------------------------------------------------------------------------

export const PARTNER_LIVE_EVENTS = ['partner_user.invited', 'partner_user.changed', 'partner_user.access_ending', 'partner_user.signed_in', 'partner_portal.settings_changed'] as const

/** A live change of this party's portal (its people or its settings). */
export const partnerChangeOf = (change: Pick<LiveChange, 'type' | 'fields'>, partyId: string): boolean => (PARTNER_LIVE_EVENTS as readonly string[]).includes(change.type) && change.fields.partyId === partyId

/** "A portal user signed in": the person's id when the change is one (the tab names them from its people). */
export const signedInOf = (change: Pick<LiveChange, 'type' | 'fields'>): string | null => (change.type === 'partner_user.signed_in' && typeof change.fields.userId === 'string' ? change.fields.userId : null)

/** A live change that moves Admin › Users' Partners count or tiles. */
export const partnersCountChange = (change: Pick<LiveChange, 'type'>): boolean => (PARTNER_LIVE_EVENTS as readonly string[]).includes(change.type)

// ---- Admin › Users "Partners" ------------------------------------------------------------------------------------------

export const PARTNER_TILES = ['invited', 'endsSoon', 'suspended', 'deactivated'] as const
export type PartnerTile = (typeof PARTNER_TILES)[number]

export const isPartnerUser = (user: Pick<User, 'audience'>): boolean => user.audience === 'PARTNER'

export function partnerTileMatch(tile: PartnerTile, user: User, now: Date): boolean {
  if (tile === 'invited') return user.status === 'INVITED'
  if (tile === 'endsSoon') return (user.status === 'ACTIVE' || user.status === 'SUSPENDED') && endsSoon(user.accessUntil, now)
  if (tile === 'suspended') return user.status === 'SUSPENDED'
  return user.status === 'DEACTIVATED'
}

/** A partner person with their organisation (from GET /partners). */
export interface PartnerUserRow {
  user: User
  organisation: Organisation | null
}

/** The Partners list: deactivated people only under their tile; by organisation, then name. */
export function partnerUserRows(users: readonly User[], organisations: readonly Organisation[], tile: PartnerTile | null, query: string, now: Date): PartnerUserRow[] {
  const byParty = new Map(organisations.map((entry) => [entry.party.id, entry]))
  return users
    .filter(isPartnerUser)
    .filter((user) => (tile ? partnerTileMatch(tile, user, now) : user.status !== 'DEACTIVATED'))
    .map((user) => ({ user, organisation: user.partyId ? (byParty.get(user.partyId) ?? null) : null }))
    .filter((row) => matches(query, row.user.displayName, row.user.email, row.organisation?.party.name, row.organisation?.party.code))
    .sort((a, b) => (a.organisation?.party.name ?? '').localeCompare(b.organisation?.party.name ?? '') || a.user.displayName.localeCompare(b.user.displayName))
}

/** The tiles' counts; "Access ends soon" is the API's own count (GET /partners) once read. */
export function partnerTileCounts(users: readonly User[] | null, counts: { accessEndingSoon: number } | null, now: Date): Record<PartnerTile, number | null> {
  const partners = users?.filter(isPartnerUser) ?? null
  const count = (tile: PartnerTile) => (partners ? partners.filter((user) => partnerTileMatch(tile, user, now)).length : null)
  return { invited: count('invited'), endsSoon: counts ? counts.accessEndingSoon : count('endsSoon'), suspended: count('suspended'), deactivated: count('deactivated') }
}

/** Where a partner's organisation opens: the customer's or the supplier's record, on its Portal access tab. */
export function organisationHref(prefix: string, organisation: Pick<Organisation, 'party' | 'kinds'>): string {
  const side = organisation.kinds.includes('CUSTOMER') ? 'sales/customers' : 'purchasing/suppliers'
  return `${prefix}/${side}/${encodeURIComponent(organisation.party.id)}?tab=portal`
}

/** The Partners bulk actions reach the ticked partner people the same way the tab's do. */
export function partnerUserReach(action: PersonAction, selected: readonly User[], can: PartnerCan): BulkReach<User> {
  const held = can.manage ? null : 'right.manage'
  if (action === 'suspend') return reachOf(selected, (user) => user.status === 'ACTIVE' && !!user.partyId, { held, none: 'held.suspendNone' })
  if (action === 'reactivate') return reachOf(selected, (user) => user.status === 'SUSPENDED' && !!user.partyId, { held, none: 'held.reactivateNone' })
  return reachOf(selected, (user) => (user.status === 'ACTIVE' || user.status === 'SUSPENDED') && !!user.partyId, { held, none: 'held.deactivateNone' })
}
