import type { Permission } from '../../core/permissions'
import { GRAINS, isGrain, type Grain } from '../grains/grains'
import { FACTORY_PERMISSIONS } from '../permissions/catalogue'

/**
 * The system role templates (plan A1 §3.11 "Role"; feature PLT-030): ready roles every tenant gets as system roles
 * (Role rows with `system` set, kept equal to these by the API's syncSystemRoles). A tenant cannot edit a system
 * role; it copies one into a custom role and edits the copy. A later change of a template reaches the system roles
 * through a sync (audited per tenant) and NEVER a custom copy: the role screens show what the template has that the
 * copy lacks (`templateAdds`), and adding it is an explicit, audited edit.
 *
 * Office roles only in W0 (B-W0-15). The floor step adds floor templates (audience `floor`); each module step adds its
 * new permissions to the templates that need them. The owner holds every declared permission and the read-only role
 * every `read` one, so they follow the registry by themselves.
 *
 * `requireMfa`: a session holds none of the role's permissions until two-factor was proved on it (A1 §3.10: owner,
 * admin, finance; and every role that sees costs or margins).
 */

export const ROLE_AUDIENCES = ['office'] as const
export type RoleAudience = (typeof ROLE_AUDIENCES)[number]

/** What a role gives. */
export interface RoleContent {
  readonly name: string
  readonly description: string
  readonly requireMfa: boolean
  readonly permissions: readonly Permission[]
  readonly grains: readonly Grain[]
}

export interface RoleTemplate extends RoleContent {
  /** Lower snake case; the system role's key in every tenant. Custom roles' keys start with `custom.` and never clash. */
  readonly key: string
  readonly audience: RoleAudience
}

const assignable = FACTORY_PERMISSIONS.assignable
const every = (filter: (risk: string) => boolean = () => true): Permission[] =>
  assignable.filter((definition) => filter(definition.risk)).map((definition) => definition.name)

const template = (key: string, content: Omit<RoleTemplate, 'key' | 'audience'>): RoleTemplate =>
  Object.freeze({ key, audience: 'office' as const, ...content, permissions: Object.freeze([...content.permissions].sort()), grains: Object.freeze([...content.grains]) })

export const ROLE_TEMPLATES: readonly RoleTemplate[] = Object.freeze([
  template('owner', {
    name: 'Owner',
    description: 'Everything, in every company, including every money figure. The tenant always keeps one.',
    requireMfa: true,
    permissions: every(),
    grains: GRAINS,
  }),
  template('admin', {
    name: 'Administrator',
    description: 'People, roles and the audit log; sees no money unless also given a role that does.',
    requireMfa: true,
    permissions: [
      'users.view',
      'users.invite',
      'users.suspend',
      'users.reactivate',
      'users.deactivate',
      'users.resetPassword',
      'roles.view',
      'roles.manage',
      'roles.assign',
      'audit.read',
      'numbering.view',
    ],
    grains: [],
  }),
  template('finance', {
    name: 'Finance',
    description: 'Invoices, payments and number series; sees prices, costs, margins and wages.',
    requireMfa: true,
    permissions: ['numbering.view', 'numbering.manage', 'audit.read'],
    grains: ['price', 'cost', 'margin', 'wages'],
  }),
  template('sales', {
    name: 'Sales',
    description: 'Customers, quotes and orders; sees selling prices, not costs or margins.',
    requireMfa: false,
    permissions: ['audit.read'],
    grains: ['price'],
  }),
  template('planner', {
    name: 'Planner',
    description: 'Plans work orders and capacity; sees no money.',
    requireMfa: false,
    permissions: [],
    grains: [],
  }),
  template('buyer', {
    name: 'Buyer',
    description: 'Suppliers and purchase orders; sees purchase prices (the cost grain).',
    requireMfa: true,
    permissions: ['audit.read'],
    grains: ['cost'],
  }),
  template('warehouse', {
    name: 'Warehouse',
    description: 'Receiving, stock and shipping; sees no money.',
    requireMfa: false,
    permissions: [],
    grains: [],
  }),
  template('production_manager', {
    name: 'Production manager',
    description: 'Runs production: work orders, lines and floor results; sees no money.',
    requireMfa: false,
    permissions: ['audit.read'],
    grains: [],
  }),
  template('quality_inspector', {
    name: 'Quality inspector',
    description: 'Inspects lots and finished goods and releases them; sees no money.',
    requireMfa: false,
    permissions: [],
    grains: [],
  }),
  template('floor_supervisor', {
    name: 'Floor supervisor',
    description: 'Follows the lines of their sites from the Office; sees no money.',
    requireMfa: false,
    permissions: [],
    grains: [],
  }),
  template('read_only', {
    name: 'Read-only',
    description: 'Sees every screen its scope reaches and changes nothing; sees no money.',
    requireMfa: false,
    permissions: every((risk) => risk === 'read'),
    grains: [],
  }),
])

const byKey = new Map(ROLE_TEMPLATES.map((entry) => [entry.key, entry]))

export function templateOf(key: string): RoleTemplate | undefined {
  return byKey.get(key)
}

/** The templates' own consistency (run at load: a template naming an unknown permission stops the import). */
export function templateProblems(templates: readonly RoleTemplate[]): string[] {
  const problems: string[] = []
  const keys = new Set<string>()
  for (const entry of templates) {
    if (!/^[a-z][a-z0-9_]{1,47}$/.test(entry.key)) problems.push(`${entry.key}: a template key is lower snake case`)
    if (keys.has(entry.key)) problems.push(`${entry.key}: declared twice`)
    keys.add(entry.key)
    for (const permission of entry.permissions) {
      const definition = FACTORY_PERMISSIONS.get(permission)
      if (!definition) problems.push(`${entry.key}: ${permission} is not declared`)
      else if (definition.grain !== undefined) problems.push(`${entry.key}: ${permission} is a grain; list it in grains`)
    }
    for (const grain of entry.grains) if (!isGrain(grain)) problems.push(`${entry.key}: ${String(grain)} is not a grain`)
    const sees = entry.grains.filter((grain) => grain === 'cost' || grain === 'margin')
    if (sees.length > 0 && !entry.requireMfa) problems.push(`${entry.key}: a role that sees ${sees.join(' and ')} requires two-factor`)
  }
  if (!keys.has('owner')) problems.push('the owner template is missing')
  return problems
}

const problems = templateProblems(ROLE_TEMPLATES)
if (problems.length > 0) throw new Error(`Role templates are not valid: ${problems.join('; ')}`)
