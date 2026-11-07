import type { Permission } from '../../core/permissions'
import { isGrain, type Grain } from '../grains/grains'
import { CAPABILITIES, CAPABILITY_ROLE_KEYS, KIND_KEY_PREFIX, PARTNER_KINDS, type Capability, type PartnerKind } from '../partners/kinds'
import { PORTAL_APPROVE, PORTAL_COLLEAGUES_MANAGE, PORTAL_COLLEAGUES_VIEW, PORTAL_COMMENT, PORTAL_UPLOAD } from '../partners/permissions'
import { FACTORY_PERMISSIONS, FILES_READ, THREADS_READ } from '../permissions/catalogue'
import type { RoleContent } from './templates'

/**
 * The partner role templates (B-W2b-162; SAL-060 customer portal roles, SCM-092 supplier users, PLT-021 external user
 * types; design portal.frame access-rules): system Role rows of audience PARTNER in every tenant, synced with these like
 * the office and floor templates (./templates SYSTEM_ROLE_TEMPLATES, the API's syncSystemRoles), given only to partner
 * people and bound to their own party. A person holds ONE main role of their kind and, beside it, the capabilities
 * (comment, upload, approve: COL-062) they were given; none is "view only".
 *
 *   customer        Buyer, Finance, Quality, Designer, Viewer, Admin — prices only for Buyer, Finance and Admin
 *   supplier        Orders, Invoices, Quality, Admin — never a price (Owner answer C2)
 *   subcontractor   Jobs, Admin — never a price
 *   guest           Accountant — read-only, an end of access always; its exports carry prices (FIN-158)
 *   partner-…       the capabilities, one permission each, for any kind
 *
 * By construction a partner role holds only partner permissions (`portal.*`, flagged `partner` in the catalogue) and the
 * office reads a portal shares with them (files and threads: what is shared with the party only), at most the price
 * grain (never cost, margin, wages or pay; the database refuses them too) and never two-factor (a portal session steps up
 * by an e-mail code). An Admin holds what every other role of its kind holds, plus managing colleagues. The pages of the
 * portal come with their steps: each gives its permissions to these templates in ./templates (PARTNER_ADDS, one line per
 * step), and the Admin of the kind follows by itself.
 */

export const PARTNER_AUDIENCE = 'partner' as const

export interface PartnerRoleTemplate extends RoleContent {
  /** `<kind>-<name>` (`customer-buyer`), or `partner-<capability>`; never clashes with an office key (no hyphen there). */
  readonly key: string
  readonly audience: typeof PARTNER_AUDIENCE
  /** The portal it is for; null: a capability, given beside a main role of any kind. */
  readonly kind: PartnerKind | null
  /** The kind's admin: manages the organisation's colleagues. */
  readonly admin: boolean
  /** A main role: what its holder may also do (COL-062), at most and by default. Empty for a capability. */
  readonly capabilities: { readonly allowed: readonly Capability[]; readonly byDefault: readonly Capability[] }
}

/** The office permissions a portal session uses on the routes it shares with the office: only what is shared with its party. */
export const PARTNER_SHARED_PERMISSIONS: readonly Permission[] = Object.freeze([FILES_READ, THREADS_READ])

/** The money a partner role may ever see. */
export const PARTNER_ROLE_GRAINS: readonly Grain[] = Object.freeze(['price'])

const ALL: readonly Capability[] = CAPABILITIES

interface MainRole {
  readonly name: string
  readonly description: string
  readonly price: boolean
  readonly allowed: readonly Capability[]
  readonly byDefault: readonly Capability[]
}

/** The main roles of each kind (the Admin of each kind but the guest is added by `partnerRoleTemplates`). */
const MAIN_ROLES: Readonly<Record<PartnerKind, Readonly<Record<string, MainRole>>>> = {
  CUSTOMER: {
    buyer: { name: 'Buyer', description: 'Orders and order requests, deliveries and tracking, with prices.', price: true, allowed: ALL, byDefault: ALL },
    finance: { name: 'Finance', description: 'Invoices, payments and statements, with prices.', price: true, allowed: ALL, byDefault: ['comment', 'upload'] },
    quality: { name: 'Quality', description: 'Certificates and declarations, quality reports, returns and complaints; no prices.', price: false, allowed: ALL, byDefault: ALL },
    designer: { name: 'Designer', description: 'Samples, tech packs, artwork and design proofs; no prices.', price: false, allowed: ALL, byDefault: ALL },
    viewer: { name: 'Viewer', description: 'Sees orders and documents and changes nothing; no prices.', price: false, allowed: ['comment'], byDefault: [] },
  },
  SUPPLIER: {
    orders: { name: 'Orders', description: 'Purchase orders to confirm, ship notices and deliveries; never a price.', price: false, allowed: ALL, byDefault: ALL },
    invoices: { name: 'Invoices', description: 'Their invoices to us and what was paid; never a price on a screen.', price: false, allowed: ALL, byDefault: ['comment', 'upload'] },
    quality: { name: 'Quality', description: 'Documents and certificates we ask for, quality claims; never a price.', price: false, allowed: ALL, byDefault: ['comment', 'upload'] },
  },
  SUBCONTRACTOR: {
    jobs: { name: 'Jobs', description: 'Jobs to accept, kits received, progress and the goods sent back; never a price.', price: false, allowed: ALL, byDefault: ALL },
  },
  GUEST: {
    accountant: { name: 'Accountant', description: "Read-only: the period's accounting exports, e-invoices and registers, and one thread with finance; until the end of access.", price: true, allowed: ['comment'], byDefault: ['comment'] },
  },
}

const ADMIN: Readonly<Record<PartnerKind, string | null>> = {
  CUSTOMER: 'Everything the other customer roles do, with prices, and the colleagues: invite, change roles, deactivate.',
  SUPPLIER: 'Everything the other supplier roles do, and the colleagues: invite, change roles, deactivate; never a price.',
  SUBCONTRACTOR: 'Everything the jobs role does, and the colleagues: invite, change roles, deactivate; never a price.',
  // An adviser is one person given access by the office: no colleagues to manage.
  GUEST: null,
}

const CAPABILITY_ROLES: Readonly<Record<Capability, { readonly name: string; readonly description: string; readonly permission: Permission }>> = {
  comment: { name: 'Can comment', description: 'Writes messages on the records the main role shows.', permission: PORTAL_COMMENT },
  upload: { name: 'Can upload', description: 'Sends files on the records the main role shows.', permission: PORTAL_UPLOAD },
  approve: { name: 'Can approve', description: 'Approves, accepts or signs on the records the main role shows.', permission: PORTAL_APPROVE },
}

const sorted = (list: Iterable<Permission>): Permission[] => [...new Set(list)].sort()

/**
 * The templates, with the permissions later portal steps give them (`adds`: one map per step, by template key). An Admin
 * holds the union of its kind's other templates (with their adds) plus managing colleagues; a step may also add to an
 * admin alone.
 */
export function partnerRoleTemplates(adds: readonly Readonly<Record<string, readonly Permission[]>>[] = []): readonly PartnerRoleTemplate[] {
  const addsOf = (key: string): Permission[] => adds.flatMap((map) => [...(map[key] ?? [])])
  const templates: PartnerRoleTemplate[] = []
  for (const kind of PARTNER_KINDS) {
    const prefix = KIND_KEY_PREFIX[kind]
    const base: Permission[] = [...PARTNER_SHARED_PERMISSIONS, ...(kind === 'GUEST' ? [] : [PORTAL_COLLEAGUES_VIEW as Permission])]
    const mains = Object.entries(MAIN_ROLES[kind]).map(([name, role]) => {
      const key = `${prefix}-${name}`
      return Object.freeze({
        key,
        audience: PARTNER_AUDIENCE,
        kind,
        admin: false,
        name: role.name,
        description: role.description,
        requireMfa: false,
        permissions: Object.freeze(sorted([...base, ...addsOf(key)])),
        grains: Object.freeze(role.price ? [...PARTNER_ROLE_GRAINS] : []),
        capabilities: Object.freeze({ allowed: Object.freeze([...role.allowed]), byDefault: Object.freeze([...role.byDefault]) }),
      }) satisfies PartnerRoleTemplate
    })
    templates.push(...mains)
    const adminWords = ADMIN[kind]
    if (adminWords !== null) {
      const key = `${prefix}-admin`
      templates.push(
        Object.freeze({
          key,
          audience: PARTNER_AUDIENCE,
          kind,
          admin: true,
          name: 'Admin',
          description: adminWords,
          requireMfa: false,
          permissions: Object.freeze(sorted([...mains.flatMap((main) => main.permissions), PORTAL_COLLEAGUES_MANAGE, ...addsOf(key)])),
          grains: Object.freeze(mains.some((main) => main.grains.length > 0) ? [...PARTNER_ROLE_GRAINS] : []),
          capabilities: Object.freeze({ allowed: ALL, byDefault: ALL }),
        }) satisfies PartnerRoleTemplate,
      )
    }
  }
  for (const capability of CAPABILITIES) {
    const role = CAPABILITY_ROLES[capability]
    templates.push(
      Object.freeze({
        key: CAPABILITY_ROLE_KEYS[capability],
        audience: PARTNER_AUDIENCE,
        kind: null,
        admin: false,
        name: role.name,
        description: role.description,
        requireMfa: false,
        permissions: Object.freeze([role.permission]),
        grains: Object.freeze([]),
        capabilities: Object.freeze({ allowed: Object.freeze([]), byDefault: Object.freeze([]) }),
      }) satisfies PartnerRoleTemplate,
    )
  }
  return Object.freeze(templates)
}

const KEY = /^(customer|supplier|subcontractor|guest|partner)-[a-z][a-z0-9_]{1,40}$/

/** What is wrong with partner templates (run at load by ./templates: a wrong one stops the import). */
export function partnerTemplateProblems(templates: readonly PartnerRoleTemplate[]): string[] {
  const problems: string[] = []
  const keys = new Set<string>()
  for (const entry of templates) {
    if (!KEY.test(entry.key)) problems.push(`${entry.key}: a partner template key is <kind>-<name> in lower case`)
    if (keys.has(entry.key)) problems.push(`${entry.key}: declared twice`)
    keys.add(entry.key)
    if (entry.kind !== null && !entry.key.startsWith(`${KIND_KEY_PREFIX[entry.kind]}-`)) problems.push(`${entry.key}: a ${entry.kind} role's key starts with ${KIND_KEY_PREFIX[entry.kind]}-`)
    for (const permission of entry.permissions) {
      const definition = FACTORY_PERMISSIONS.get(permission)
      if (!definition) problems.push(`${entry.key}: ${permission} is not declared`)
      else if (definition.partner !== true && !PARTNER_SHARED_PERMISSIONS.includes(permission)) problems.push(`${entry.key}: a partner role holds only partner permissions, not ${permission}`)
    }
    for (const grain of entry.grains) {
      if (!isGrain(grain) || !PARTNER_ROLE_GRAINS.includes(grain)) problems.push(`${entry.key}: a partner role sees at most the price, not ${String(grain)}`)
    }
    if ((entry.kind === 'SUPPLIER' || entry.kind === 'SUBCONTRACTOR') && entry.grains.length > 0) problems.push(`${entry.key}: no price on a supplier's or workshop's portal (Owner answer C2)`)
    if (entry.requireMfa) problems.push(`${entry.key}: a partner role cannot require two-factor (a portal session steps up by e-mail code)`)
    if (entry.capabilities.byDefault.some((capability) => !entry.capabilities.allowed.includes(capability))) problems.push(`${entry.key}: a default capability it does not allow`)
  }
  return problems
}
