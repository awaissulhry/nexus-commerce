import type { Grant, Permission } from '../../core/permissions'
import { isGrain, type Grain } from '../grains/grains'
import { grantOf } from '../roles/roles'

/**
 * The grants of a floor session (plan A1 §2.6, §3.10, §3.11): one per live floor role of the signed-in worker, over
 * the device's company and site only (a floor session is bound to its device's site, whatever the role says).
 *
 *   - Only FLOOR roles count (an office role of a worker's linked office user gives the floor nothing).
 *   - Money: a floor session sees at most `wages` (FLOOR_GRAINS); any other grain a role names is dropped here, before
 *     the API's own cap (heldGrains) and the database's column grants. Wages are "own records only": a later step
 *     checks each wage record with can() against the worker (W2, behind the legal switch).
 *   - A worker whose PIN must change holds nothing until they changed it.
 */

export const FLOOR_GRAINS: readonly Grain[] = Object.freeze(['wages'])

export interface FloorRole {
  readonly permissions: readonly string[]
  readonly grains: readonly string[]
}

export interface FloorPlace {
  readonly companyId: string
  readonly siteId: string
}

/** The session's grants: one per role, over the device's company and site; nothing while the PIN must change. */
export function floorGrants(roles: readonly FloorRole[], place: FloorPlace, options: { readonly pinMustChange?: boolean } = {}): Grant[] {
  if (options.pinMustChange) return []
  const scope = { allCompanies: false, companyIds: [place.companyId], siteIds: [place.siteId], partyIds: [] }
  return roles.map((role) =>
    grantOf(
      {
        permissions: role.permissions.filter((permission) => !permission.startsWith('money.')) as Permission[],
        grains: role.grains.filter((grain): grain is Grain => isGrain(grain) && FLOOR_GRAINS.includes(grain)),
      },
      scope,
    ),
  )
}
