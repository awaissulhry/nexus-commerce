import type { Issue } from '../../core/errors'
import type { Permission } from '../../core/permissions'
import { FACTORY_PERMISSIONS } from '../permissions/catalogue'
import { PARTNER_ROLE_TEMPLATES, partnerTemplateOf } from '../roles/templates'
import type { PartnerRoleTemplate } from '../roles/partner-templates'
import { CAPABILITIES, CAPABILITY_ROLE_KEYS, capabilityOfKey, sortedCapabilities, type Capability, type PartnerKind } from './kinds'

/**
 * Partner people within the factory's limits (B-W2b-162; PLT-006, PLT-021, PLT-022, SAL-060, SCM-092). Pure: the API
 * reads the party, its PortalSettings and its people, and asks here.
 *
 *   a choice      ONE main role of the person's kind (a partner template) and the capabilities it allows (COL-062), an
 *                 end of access (PLT-022: always for a GUEST, in the future);
 *   the limits    PortalSettings.allowedRoleKeys (empty: every role of the kind) and maxUsers (null: no limit), counted
 *                 over the people who hold a seat: ACTIVE, SUSPENDED, or INVITED with an open invitation;
 *   who chooses   the office within these limits; the partner's own admin also only for colleagues of its kind and no
 *                 later end of access than its own (a colleague never outlives the admin who invited them).
 * The invitation carries the choice as role keys (main + `partner-<capability>`); the first sign-in gives those roles
 * (B-W2b-159).
 */

export const PARTNER_PEOPLE = Object.freeze({
  /** An invitation to the portal works this long (design admin.users invite: "The invite works for 7 days"). */
  invitationTtlMs: 7 * 24 * 60 * 60_000,
  /** "Access ends soon": the notice goes this long before an end of access (PLT-022). */
  accessEndingNoticeMs: 7 * 24 * 60 * 60_000,
  /** An office preview of a portal lasts at most this long (a support look, not a working session). */
  previewMs: 60 * 60_000,
})

/** The main roles a person of this kind may hold (the capabilities are given beside them). */
export const mainTemplatesOf = (kind: PartnerKind): readonly PartnerRoleTemplate[] => PARTNER_ROLE_TEMPLATES.filter((template) => template.kind === kind)

/** The main roles a party's portal offers for this kind: its allowed list (empty: all of the kind). */
export function offeredTemplates(kind: PartnerKind, allowedRoleKeys: readonly string[]): readonly PartnerRoleTemplate[] {
  const all = mainTemplatesOf(kind)
  return allowedRoleKeys.length === 0 ? all : all.filter((template) => allowedRoleKeys.includes(template.key))
}

/** The role keys of a choice, as the invitation stores them: the main role first, then the capabilities in order. */
export const roleKeysOf = (roleKey: string, capabilities: readonly Capability[]): string[] => [roleKey, ...sortedCapabilities(capabilities).map((capability) => CAPABILITY_ROLE_KEYS[capability])]

/** Role keys read back: the main role (the first key of a main template), the capabilities, the keys that are neither. */
export function splitRoleKeys(keys: readonly string[]): { readonly roleKey: string | null; readonly capabilities: Capability[]; readonly unknown: string[] } {
  let roleKey: string | null = null
  const capabilities: Capability[] = []
  const unknown: string[] = []
  for (const key of keys) {
    const capability = capabilityOfKey(key)
    if (capability) capabilities.push(capability)
    else if (roleKey === null && partnerTemplateOf(key)?.kind) roleKey = key
    else unknown.push(key)
  }
  return { roleKey, capabilities: sortedCapabilities(capabilities), unknown }
}

export interface AccessChoice {
  readonly kind: PartnerKind
  readonly roleKey: string
  readonly capabilities: readonly Capability[]
  /** The end of access (PLT-022); null: none. */
  readonly accessUntil: Date | null
}

export interface PortalLimits {
  readonly maxUsers: number | null
  readonly allowedRoleKeys: readonly string[]
}

/** What is wrong with a choice (paths name the body fields). */
export function choiceProblems(choice: AccessChoice, limits: PortalLimits, now: Date): Issue[] {
  const issues: Issue[] = []
  const template = partnerTemplateOf(choice.roleKey)
  if (!template || template.kind !== choice.kind) {
    issues.push({ path: 'roleKey', message: `Choose one of the roles of the ${KIND_WORDS[choice.kind]} portal: ${mainTemplatesOf(choice.kind).map((entry) => entry.name).join(', ')}.` })
  } else if (limits.allowedRoleKeys.length > 0 && !limits.allowedRoleKeys.includes(choice.roleKey)) {
    issues.push({ path: 'roleKey', message: `This organisation's portal offers only: ${offeredTemplates(choice.kind, limits.allowedRoleKeys).map((entry) => entry.name).join(', ') || 'no role of this kind'}.` })
  }
  if (new Set(choice.capabilities).size !== choice.capabilities.length) issues.push({ path: 'capabilities', message: 'A capability is listed twice.' })
  choice.capabilities.forEach((capability, index) => {
    if (!(CAPABILITIES as readonly string[]).includes(capability)) issues.push({ path: `capabilities/${index}`, message: `Expected one of ${CAPABILITIES.join(', ')}.` })
    else if (template && !template.capabilities.allowed.includes(capability)) issues.push({ path: `capabilities/${index}`, message: `A ${template.name} cannot ${CAPABILITY_WORDS[capability]}.` })
  })
  if (choice.accessUntil === null) {
    if (choice.kind === 'GUEST') issues.push({ path: 'accessUntil', message: "An adviser's access always ends: give the date." })
  } else if (choice.accessUntil.getTime() <= now.getTime()) {
    issues.push({ path: 'accessUntil', message: 'The end of access must be in the future.' })
  }
  return issues
}

/** The roles' allowed list of a party's portal settings: main templates only, each once (any kind the party may have). */
export function allowedRoleKeysProblems(keys: readonly string[]): Issue[] {
  const issues: Issue[] = []
  if (new Set(keys).size !== keys.length) issues.push({ path: 'allowedRoleKeys', message: 'A role is listed twice.' })
  keys.forEach((key, index) => {
    if (!partnerTemplateOf(key)?.kind) issues.push({ path: `allowedRoleKeys/${index}`, message: `${key} is not a portal role.` })
  })
  return issues
}

/** A person of a party who holds one of its seats (maxUsers). */
export const holdsSeat = (person: { readonly status: string; readonly invitationOpen: boolean }): boolean =>
  person.status === 'ACTIVE' || person.status === 'SUSPENDED' || (person.status === 'INVITED' && person.invitationOpen)

/** The refusal when no seat is left for one more person, or null. `taken` leaves out the person the change is for. */
export function seatProblem(limits: Pick<PortalLimits, 'maxUsers'>, taken: number, organisation: string): string | null {
  if (limits.maxUsers === null || taken < limits.maxUsers) return null
  return `The portal of ${organisation} holds at most ${limits.maxUsers} ${limits.maxUsers === 1 ? 'person' : 'people'}, and ${taken} ${taken === 1 ? 'is' : 'are'} invited or active. Deactivate someone first, or ask for more.`
}

/** The access ends within the notice window (7 days) and has not ended yet. */
export function accessEndsSoon(accessUntil: Date | null, now: Date): boolean {
  if (accessUntil === null) return false
  const left = accessUntil.getTime() - now.getTime()
  return left > 0 && left <= PARTNER_PEOPLE.accessEndingNoticeMs
}

/**
 * What an office preview of a party's portal may read: the read permissions every main role of the party's kinds holds
 * (what its people could read), never a write and never money (a preview is support: prices stay on the office's own
 * screens). The authenticator gives them over the session's company and the party.
 */
export function previewPermissions(kinds: readonly PartnerKind[]): Permission[] {
  const names = PARTNER_ROLE_TEMPLATES.filter((template) => template.kind !== null && kinds.includes(template.kind)).flatMap((template) => template.permissions)
  return [...new Set(names)].filter((name) => FACTORY_PERMISSIONS.get(name)?.risk === 'read').sort()
}

const KIND_WORDS: Readonly<Record<PartnerKind, string>> = { CUSTOMER: 'customer', SUPPLIER: 'supplier', SUBCONTRACTOR: 'workshop', GUEST: 'adviser' }
const CAPABILITY_WORDS: Readonly<Record<Capability, string>> = { comment: 'write messages', upload: 'send files', approve: 'approve or sign' }

/** The refusals in words, said by the office and the portal alike. */
export const PARTNER_WORDS = Object.freeze({
  noKind: 'This organisation has no portal: it is neither a customer, a brand, a supplier, a workshop nor an adviser (its roles).',
  kindNeeded: (kinds: readonly PartnerKind[]) => `This organisation has more than one portal (${kinds.map((kind) => KIND_WORDS[kind]).join(', ')}): say which one the person is for.`,
  kindDoesNotFit: (kind: PartnerKind) => `This organisation is not a ${KIND_WORDS[kind]} (its roles): it has no ${KIND_WORDS[kind]} portal.`,
  blocked: 'This organisation is blocked or archived: unblock it before its people get access.',
  officeAddress: 'This address belongs to a person of the Office. A portal account is a different address.',
  otherOrganisation: 'This address belongs to a person of another organisation: one address is one account. Deactivate that one first, or use another address.',
  alreadyIn: 'This person already has access to the portal (or is suspended): change their role instead.',
  rolesNotReady: 'The portal roles are not set up in this tenant yet: an administrator brings the role templates up to date (Admin › Roles).',
  ownAccess: 'You cannot change your own access; ask another admin of your organisation, or the factory.',
  notInvited: 'This person has no open invitation.',
  stillInvited: 'This person has not signed in yet: change the invitation instead (send it again).',
  noPortalCompany: 'Say which company this portal is for: the organisation works with every company of the factory.',
  wrongCompany: 'This organisation belongs to another company: its portal is that company\'s.',
  progressOnlyCustomers: 'Production progress shows only to a customer or a brand (Owner answer C1).',
})
