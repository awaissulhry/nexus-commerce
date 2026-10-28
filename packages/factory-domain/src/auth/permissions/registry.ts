import { isPermission, type Permission } from '../../core/permissions'
import type { Grain } from '../grains/grains'

/**
 * The permission registry (plan A1 §3.11 "Permission"; feature PLT-029: every action has a permission, declared
 * once). A permission is `<area>.<action>`; each area declares its own with `definePermissions` (a module in its
 * `factory-domain/src/<module>/permissions.ts`), and `./catalogue` assembles them into FACTORY_PERMISSIONS, which
 *   - the API's boot checks every route manifest against (an undeclared permission stops the boot),
 *   - role templates and custom roles are checked against (an unknown permission is refused),
 *   - the role screens list, grouped by area, with what each allows and how risky it is.
 *
 * Risk:
 *   read     only reads
 *   write    changes data
 *   stepUp   changes access, money or legal records: the route also asks for a fresh step-up (A1 §3.10)
 */

export const PERMISSION_RISKS = ['read', 'write', 'stepUp'] as const
export type PermissionRisk = (typeof PERMISSION_RISKS)[number]

export interface PermissionDefinition {
  readonly name: Permission
  /** The area (module) it belongs to: the part before the first dot. */
  readonly area: string
  /** What holding it allows, for the person who assigns roles. */
  readonly description: string
  readonly risk: PermissionRisk
  /** Set for a money grain (`money.cost`…): it comes from Role.grains, never from Role.permissions. */
  readonly grain?: Grain
}

export interface PermissionDeclaration {
  readonly description: string
  readonly risk: PermissionRisk
}

export class PermissionRegistryError extends Error {
  override name = 'PermissionRegistryError'
}

const AREA = /^[a-z][a-zA-Z0-9]*$/

/** Declares an area's permissions: `definePermissions('numbering', { view: {…}, manage: {…} })`. */
export function definePermissions(area: string, declarations: Readonly<Record<string, PermissionDeclaration>>): PermissionDefinition[] {
  if (!AREA.test(area)) throw new PermissionRegistryError(`"${area}" is not an area name (lower camel case)`)
  return Object.entries(declarations).map(([action, { description, risk }]) => {
    const name = `${area}.${action}`
    if (!isPermission(name)) throw new PermissionRegistryError(`"${name}" is not <area>.<action>`)
    if (!(PERMISSION_RISKS as readonly string[]).includes(risk)) throw new PermissionRegistryError(`${name}: unknown risk "${String(risk)}"`)
    if (description.trim() === '') throw new PermissionRegistryError(`${name}: a description is required`)
    return Object.freeze({ name, area, description, risk })
  })
}

export interface PermissionRegistry {
  /** Every declared permission, in declaration order. */
  readonly all: readonly PermissionDefinition[]
  /** The permissions a role may list (every one but the grains). */
  readonly assignable: readonly PermissionDefinition[]
  get(name: string): PermissionDefinition | undefined
  isDeclared(name: string): boolean
  /** The names of this list that are not declared, sorted, once each. */
  undeclared(names: Iterable<string>): string[]
  /** The declared permissions per area, for the role screens. */
  byArea(): ReadonlyMap<string, readonly PermissionDefinition[]>
}

/** Assembles area lists into one registry. A name declared twice, or in the wrong area, throws. */
export function permissionRegistry(lists: readonly (readonly PermissionDefinition[])[]): PermissionRegistry {
  const byName = new Map<string, PermissionDefinition>()
  for (const definition of lists.flat()) {
    if (byName.has(definition.name)) throw new PermissionRegistryError(`${definition.name} is declared twice`)
    if (!definition.name.startsWith(`${definition.area}.`)) throw new PermissionRegistryError(`${definition.name} is not in its area ${definition.area}`)
    byName.set(definition.name, Object.freeze({ ...definition }))
  }
  const all = Object.freeze([...byName.values()])
  const assignable = Object.freeze(all.filter((definition) => definition.grain === undefined))
  return {
    all,
    assignable,
    get: (name) => byName.get(name),
    isDeclared: (name) => byName.has(name),
    undeclared: (names) => [...new Set([...names].filter((name) => !byName.has(name)))].sort(),
    byArea() {
      const areas = new Map<string, PermissionDefinition[]>()
      for (const definition of all) areas.set(definition.area, [...(areas.get(definition.area) ?? []), definition])
      return areas
    },
  }
}
