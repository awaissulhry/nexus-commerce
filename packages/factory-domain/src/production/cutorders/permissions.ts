import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * Cut orders and cut tickets (B-W2b-112; MES-034, MES-037, MES-041, MES-043; design production.cutting "Cut orders", pop "New
 * cut order", record tab "Lay or hides" › "Lays"; floor.fabriccut "Cut ticket", "Cut", "Ply stickers"), in the production
 * area. Checked with can() against the cut order's company and site.
 *
 *   production.cutorders.manage  the office plans cut orders over several work orders of one material and colour (the cells,
 *                                the marker and its size ratio, the plies and the lays), releases them with their tickets,
 *                                sends one back to planning or cancels it, allocates fabric rolls to the lays by shade, width
 *                                and shrinkage, prints the tickets and voids a lost one
 *
 * Reading cut orders is the cutting room's production.cutting.view (../cutting/permissions); the table's scans of a ticket at
 * the start and the end of cutting and its ply stickers are production.cut, which the floor already holds. Nothing here
 * carries money, and nothing names the worker who spread, cut or numbered (Statuto dei Lavoratori art. 4).
 */
export const PRODUCTION_CUTORDERS_DEFINITIONS = definePermissions('production', {
  'cutorders.manage': {
    risk: 'write',
    description:
      'Plan cut orders that group work orders of one material and colour (the cells, the marker with its size ratio, the plies and the lays), release them with their cut tickets, send one back to planning or cancel it, allocate fabric rolls to the lays by shade, width and shrinkage, print the tickets and void a lost one.',
  },
})

export const PRODUCTION_CUTORDERS_MANAGE = 'production.cutorders.manage' satisfies Permission

export const PRODUCTION_CUTORDERS_PERMISSIONS: readonly Permission[] = Object.freeze([PRODUCTION_CUTORDERS_MANAGE])

/**
 * The office role templates that plan cut orders (roles/templates addedFor; Owner from every()): the production manager, and the
 * planner, who also reads the Cutting page (production.cutting.view) where cut orders are planned. Floor roles already hold
 * production.cut for the scans and the stickers.
 */
export const CUT_ORDERS_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  production_manager: [PRODUCTION_CUTORDERS_MANAGE],
  planner: ['production.cutting.view', PRODUCTION_CUTORDERS_MANAGE],
})
