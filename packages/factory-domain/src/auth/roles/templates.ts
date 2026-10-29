import type { Permission } from '../../core/permissions'
import { GRAINS, isGrain, type Grain } from '../grains/grains'
import { FACTORY_PERMISSIONS, FLOOR_AREA, FLOOR_SHARED_PERMISSIONS } from '../permissions/catalogue'

/**
 * The system role templates (plan A1 §3.11 "Role"; feature PLT-030): ready roles every tenant gets as system roles
 * (Role rows with `system` set, kept equal to these by the API's syncSystemRoles). A tenant cannot edit a system
 * role; it copies one into a custom role and edits the copy. A later change of a template reaches the system roles
 * through a sync (audited per tenant) and NEVER a custom copy: the role screens show what the template has that the
 * copy lacks (`templateAdds`), and adding it is an explicit, audited edit.
 *
 * Office roles (B-W0-15) and floor roles (B-W0-16, audience `floor`: given to floor workers, never to office users,
 * and held only by a floor session on an enrolled device). A floor role holds only `floor.*` permissions, sees at
 * most wages and never requires two-factor (the device and the PIN are the floor's factors); an office role holds no
 * `floor.*` permission. The few office permissions the floor uses on the same routes, at its own site only
 * (FLOOR_SHARED_PERMISSIONS: printing labels, the site's locations and transfers between them, picking and issuing to the
 * site's work orders, packing shipments), are the exception a floor role may hold. Each module step adds its new
 * permissions to the templates that need them. The owner holds
 * every declared office permission and the read-only role every office `read` one, so they follow the registry by
 * themselves.
 *
 * `requireMfa`: a session holds none of the role's permissions until two-factor was proved on it (A1 §3.10: owner,
 * admin, finance; and every role that sees costs or margins).
 */

export const ROLE_AUDIENCES = ['office', 'floor'] as const
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

const assignable = FACTORY_PERMISSIONS.assignable.filter((definition) => definition.area !== FLOOR_AREA)
const every = (filter: (risk: string) => boolean = () => true): Permission[] =>
  assignable.filter((definition) => filter(definition.risk)).map((definition) => definition.name)

const template = (key: string, content: Omit<RoleTemplate, 'key' | 'audience'>, audience: RoleAudience = 'office'): RoleTemplate =>
  Object.freeze({ key, audience, ...content, permissions: Object.freeze([...content.permissions].sort()), grains: Object.freeze([...content.grains]) })
const floorTemplate = (key: string, content: Omit<RoleTemplate, 'key' | 'audience' | 'requireMfa'>): RoleTemplate =>
  template(key, { ...content, requireMfa: false }, 'floor')

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
      'files.read',
      'files.upload',
      'files.manage',
      'files.delete',
      'devices.view',
      'devices.manage',
      'devices.revoke',
      'workers.view',
      'workers.manage',
      'workers.roles',
      'workers.credentials',
      'threads.read',
      'threads.post',
      'threads.manage',
      'imports.view',
      'imports.run',
      'imports.apply',
      'documents.view',
      'print.view',
      'print.manage',
      'email.send',
      'email.manage',
      'email.triage',
      'shipping.settings.view',
      'shipping.settings.manage',
      'production.settings.view',
    ],
    grains: [],
  }),
  template('finance', {
    name: 'Finance',
    description: 'Invoices, payments and number series; sees prices, costs, margins and wages.',
    requireMfa: true,
    permissions: ['numbering.view', 'numbering.manage', 'audit.read', 'files.read', 'files.upload', 'threads.read', 'threads.post', 'documents.view', 'print.view', 'print.documents', 'email.send', 'product.materials.view', 'product.materials.cost', 'product.styles.view', 'product.bom.view', 'product.routing.view', 'inventory.locations.view', 'inventory.stock.view', 'shipping.view', 'parties.view', 'parties.manage', 'parties.block', 'parties.vies', 'invoices.view', 'invoices.manage', 'invoices.issue', 'payments.view', 'payments.record', 'payments.void', 'costing.view', 'costing.rates.manage'],
    grains: ['price', 'cost', 'margin', 'wages'],
  }),
  template('sales', {
    name: 'Sales',
    description: 'Customers, quotes and orders; sees selling prices, not costs or margins.',
    requireMfa: false,
    permissions: ['audit.read', 'files.read', 'files.upload', 'threads.read', 'threads.post', 'documents.view', 'print.view', 'print.documents', 'email.send', 'email.triage', 'product.materials.view', 'product.styles.view', 'shipping.view', 'imports.view', 'imports.run', 'imports.apply', 'parties.view', 'parties.manage', 'parties.vies', 'invoices.view', 'payments.view', 'costing.view', 'workorders.view'],
    grains: ['price'],
  }),
  template('planner', {
    name: 'Planner',
    description: 'Plans work orders and capacity; sees no money.',
    requireMfa: false,
    permissions: ['files.read', 'files.upload', 'threads.read', 'threads.post', 'print.view', 'print.labels', 'print.documents', 'product.materials.view', 'product.styles.view', 'product.bom.view', 'product.routing.view', 'compliance.certificates.view', 'inventory.locations.view', 'inventory.stock.view', 'shipping.view', 'planning.view', 'planning.run', 'planning.decide', 'workorders.view', 'workorders.manage', 'workorders.release'],
    grains: [],
  }),
  template('buyer', {
    name: 'Buyer',
    description: 'Suppliers and purchase orders; sees purchase prices (the cost grain).',
    requireMfa: true,
    permissions: [
      'audit.read',
      'files.read',
      'files.upload',
      'threads.read',
      'threads.post',
      'documents.view',
      'print.view',
      'print.documents',
      'email.send',
      'email.triage',
      'imports.view',
      'imports.run',
      'imports.apply',
      'product.materials.view',
      'product.materials.manage',
      'product.materials.cost',
      'product.styles.view',
      'product.bom.view',
      'inventory.locations.view',
      'inventory.stock.view',
      'parties.view',
      'parties.manage',
      'parties.vies',
      'planning.view',
      'planning.run',
      'planning.decide',
      'costing.view',
    ],
    grains: ['cost'],
  }),
  template('warehouse', {
    name: 'Warehouse',
    description: 'Receiving, stock and shipping; sees no money.',
    requireMfa: false,
    permissions: [
      'files.read',
      'files.upload',
      'threads.read',
      'threads.post',
      'print.view',
      'print.labels',
      'print.documents',
      'imports.view',
      'imports.run',
      'imports.apply',
      'product.materials.view',
      'product.styles.view',
      'inventory.locations.view',
      'inventory.locations.manage',
      'inventory.stock.view',
      'inventory.adjust',
      'inventory.transfer',
      'inventory.scrap',
      'inventory.reverse',
      'inventory.issue',
      'inventory.issue.over',
      'shipping.view',
      'shipping.manage',
      'shipping.pack',
      'shipping.settings.view',
      'shipping.settings.manage',
      'shipping.ddt.issue',
      'shipping.ddt.cancel',
      'parties.view',
      'workorders.view',
    ],
    grains: [],
  }),
  template('production_manager', {
    name: 'Production manager',
    description: 'Runs production: work orders, lines and floor results; sees no money.',
    requireMfa: false,
    permissions: [
      'audit.read',
      'files.read',
      'files.upload',
      'devices.view',
      'workers.view',
      'threads.read',
      'threads.post',
      'print.view',
      'print.labels',
      'print.documents',
      'imports.view',
      'imports.run',
      'imports.apply',
      'product.materials.view',
      'product.materials.manage',
      'product.styles.view',
      'product.styles.manage',
      'product.bom.view',
      'product.bom.manage',
      'product.bom.release',
      'product.routing.view',
      'product.routing.manage',
      'product.operations.manage',
      'compliance.certificates.view',
      'inventory.locations.view',
      'inventory.stock.view',
      'inventory.transfer',
      'inventory.scrap',
      'inventory.issue',
      'inventory.issue.over',
      'shipping.view',
      'planning.view',
      'costing.view',
      'production.settings.view',
      'production.settings.manage',
      'workorders.view',
      'workorders.manage',
      'workorders.release',
    ],
    grains: [],
  }),
  template('quality_inspector', {
    name: 'Quality inspector',
    description: 'Inspects lots and finished goods and releases them; sees no money.',
    requireMfa: false,
    permissions: ['files.read', 'files.upload', 'threads.read', 'threads.post', 'print.view', 'print.labels', 'product.materials.view', 'product.styles.view', 'product.bom.view', 'product.routing.view', 'compliance.certificates.view', 'compliance.certificates.manage', 'inventory.locations.view', 'inventory.stock.view', 'inventory.transfer', 'inventory.scrap', 'parties.view', 'workorders.view'],
    grains: [],
  }),
  template('floor_supervisor', {
    name: 'Floor supervisor',
    description: 'Follows the lines of their sites from the Office, and keeps their floor devices, workers, badges and PINs; sees no money.',
    requireMfa: false,
    permissions: ['files.read', 'devices.view', 'devices.manage', 'devices.revoke', 'workers.view', 'workers.manage', 'workers.roles', 'workers.credentials', 'threads.read', 'threads.post', 'print.view', 'print.labels', 'product.materials.view', 'product.styles.view', 'product.routing.view', 'inventory.locations.view', 'inventory.stock.view', 'inventory.transfer', 'production.settings.view', 'workorders.view'],
    grains: [],
  }),
  template('read_only', {
    name: 'Read-only',
    description: 'Sees every screen its scope reaches and changes nothing; sees no money.',
    requireMfa: false,
    permissions: every((risk) => risk === 'read'),
    grains: [],
  }),
  floorTemplate('operator', {
    name: 'Operator',
    description: 'Works at a station on an enrolled floor device; sees no money.',
    permissions: ['floor.work', 'print.view', 'print.labels', 'inventory.locations.view', 'inventory.transfer', 'inventory.issue', 'shipping.pack'],
    grains: [],
  }),
  floorTemplate('cutting_operator', {
    name: 'Cutting operator',
    description: 'Works at a cutting table on an enrolled floor device; sees no money.',
    permissions: ['floor.work', 'print.view', 'print.labels', 'inventory.locations.view', 'inventory.transfer', 'inventory.issue'],
    grains: [],
  }),
  floorTemplate('floor_inspector', {
    name: 'Floor inspector',
    description: 'Inspects work at an inspection bench on an enrolled floor device; sees no money.',
    permissions: ['floor.work', 'print.view', 'print.labels', 'inventory.locations.view', 'inventory.transfer'],
    grains: [],
  }),
  floorTemplate('team_leader', {
    name: 'Team leader',
    description: "Leads a crew on the floor: works and sees the team leader's screens of the device's site; sees no money.",
    permissions: ['floor.work', 'floor.lead', 'print.view', 'print.labels', 'inventory.locations.view', 'inventory.transfer', 'inventory.issue', 'shipping.pack'],
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
    problems.push(...audienceProblems(entry).map((problem) => `${entry.key}: ${problem}`))
    const sees = entry.grains.filter((grain) => grain === 'cost' || grain === 'margin')
    if (sees.length > 0 && !entry.requireMfa) problems.push(`${entry.key}: a role that sees ${sees.join(' and ')} requires two-factor`)
  }
  if (!keys.has('owner')) problems.push('the owner template is missing')
  return problems
}

/**
 * What a role's audience forbids in its content: a floor role holds only `floor.*` permissions (and the few shared with
 * the floor), at most the wages grain and no two-factor rule; an office role holds no `floor.*` permission.
 */
export function audienceProblems(role: { readonly audience: RoleAudience } & Pick<RoleContent, 'permissions' | 'grains' | 'requireMfa'>): string[] {
  const floorPermission = (permission: string) => FACTORY_PERMISSIONS.get(permission)?.area === FLOOR_AREA
  const sharedWithFloor = (permission: string) => (FLOOR_SHARED_PERMISSIONS as readonly string[]).includes(permission)
  if (role.audience === 'floor') {
    const problems: string[] = []
    for (const permission of role.permissions) {
      if (!floorPermission(permission) && !sharedWithFloor(permission)) problems.push(`a floor role holds only floor permissions, not ${permission}`)
    }
    for (const grain of role.grains) if (grain !== 'wages') problems.push(`a floor role sees at most wages, not ${grain}`)
    if (role.requireMfa) problems.push('a floor role cannot require two-factor')
    return problems
  }
  return role.permissions.filter(floorPermission).map((permission) => `${permission} is held only by floor roles`)
}

const problems = templateProblems(ROLE_TEMPLATES)
if (problems.length > 0) throw new Error(`Role templates are not valid: ${problems.join('; ')}`)
