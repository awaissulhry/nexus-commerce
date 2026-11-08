import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * After the cut (B-W2b-117; MES-044 recut and panel replacement, MES-047 secondary processes after cutting, MES-048 cut issue to
 * sewing; design floor.fabriccut "Recut tickets" and "Send to sewing", production.cutting), in the production area. Checked with
 * can() against the work order's (or the trolley's) company and site; a floor device works at its own site only (can() pins it,
 * row-level security too). Shared with the floor (FLOOR_SHARED_PERMISSIONS): each is done at a tablet as much as in the office.
 *
 *   production.recuts     ask for replacement panels of a bundle (a recut ticket: the part, the sets, the same shade lot or end
 *                         bits; the office numbers it, a tablet's ask is numbered by the system), and void one in the office
 *   production.secondary  give a bundle a secondary process after cutting (fusing, perforation, print, embroidery), in house at a
 *                         work centre or outside under a subcontract order, start it, finish it, cancel it
 *   production.trolleys   scan bundles onto a trolley, send it to a sewing line, confirm it at the line by scanning the trolley's
 *                         label (the differences in words), take a bundle off, cancel a trolley
 *
 * Reading the lists in the office is the cutting room's production.cutting.view (../cutting/permissions); the cutting table cuts
 * a recut ticket (its start and end scans) and prints it with production.cut, which the floor already holds. Nothing here carries
 * money, and nothing names the worker who asked, cut, carried or received (Statuto dei Lavoratori art. 4).
 */
export const PRODUCTION_CUTISSUE_DEFINITIONS = definePermissions('production', {
  recuts: {
    risk: 'write',
    description:
      'Ask for replacement panels of a bundle (a recut ticket: the part, the sets, cut from the same shade lot or from end bits, that join the original bundle), and void a recut ticket in the office.',
  },
  secondary: {
    risk: 'write',
    description:
      'Give bundles a secondary process after cutting (fusing, perforation, print or embroidery; in house at a work centre or outside under a subcontract order), start it, finish it or cancel it.',
  },
  trolleys: {
    risk: 'write',
    description:
      'Scan cut bundles onto a trolley, send it to a sewing line, confirm it at the line by scanning the trolley’s label (bundles not found are recorded as differences), take a bundle off, or cancel a trolley.',
  },
})

export const PRODUCTION_RECUTS = 'production.recuts' satisfies Permission
export const PRODUCTION_SECONDARY = 'production.secondary' satisfies Permission
export const PRODUCTION_TROLLEYS = 'production.trolleys' satisfies Permission

export const PRODUCTION_CUTISSUE_PERMISSIONS: readonly Permission[] = Object.freeze([PRODUCTION_RECUTS, PRODUCTION_SECONDARY, PRODUCTION_TROLLEYS])

/** What a floor role may hold of them (FLOOR_SHARED_PERMISSIONS): all three, at its own site. */
export const PRODUCTION_CUTISSUE_FLOOR_PERMISSIONS: readonly Permission[] = Object.freeze([PRODUCTION_RECUTS, PRODUCTION_SECONDARY, PRODUCTION_TROLLEYS])

/**
 * The role templates (roles/templates addedFor; Owner from every()). Office: the production manager does all three; the quality
 * inspector asks for recuts (a rejected panel); the floor supervisor asks for recuts, keeps the secondary processes and the
 * trolleys of the site. Floor: the team leader (sewing asks for panels, its line confirms trolleys) and the floor inspector (quality
 * asks for panels) ask for recuts; the cutting operator, the operator and the team leader move secondary processes and trolleys.
 */
export const CUTISSUE_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  production_manager: [PRODUCTION_RECUTS, PRODUCTION_SECONDARY, PRODUCTION_TROLLEYS],
  quality_inspector: [PRODUCTION_RECUTS],
  floor_supervisor: [PRODUCTION_RECUTS, PRODUCTION_SECONDARY, PRODUCTION_TROLLEYS],
})
export const CUTISSUE_FLOOR_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  team_leader: [PRODUCTION_RECUTS, PRODUCTION_SECONDARY, PRODUCTION_TROLLEYS],
  floor_inspector: [PRODUCTION_RECUTS],
  cutting_operator: [PRODUCTION_SECONDARY, PRODUCTION_TROLLEYS],
  operator: [PRODUCTION_SECONDARY, PRODUCTION_TROLLEYS],
})
