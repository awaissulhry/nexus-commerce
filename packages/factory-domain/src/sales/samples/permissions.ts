import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * Sample rounds (B-W2b-246; SAL-311, SAL-316, MES-018; design products.samples), in the sales area: sales owns sample orders
 * and their shipments (SCOPE SAL-316). Office only. Each round is checked with can() against its company and, when it is for a
 * customer, that customer (a role limited to some customers sees only their rounds; an internal round reaches every role of the
 * company).
 *
 *   sales.samples.view     the rounds board and list with their tiles, a round with its request, its sample work orders,
 *                          its shipments and its decision as recorded; the charge only with the price grain (money.price)
 *   sales.samples.manage   ask for a round (style, pinned revision, kind and round, customer, colours, sizes and quantities,
 *                          due day, instructions, charge), change it while it is open, move it on the board, cancel it with
 *                          why; add, change and remove its shipments (courier, tracking, sent, received); make its sample
 *                          work order (which also needs workorders.manage at the making site: W1's own check)
 *
 * The decision (approved, approved with comments, rejected) is B-W2b-252's (sample decisions), with its own permission.
 */
export const SALES_SAMPLES_DEFINITIONS = definePermissions('sales', {
  'samples.view': {
    risk: 'read',
    description: 'See sample rounds (proto, fit, salesman, pre-production, CE test and brand samples): the board, what each round asks, its sample work orders, its shipments and its decision. The charge to the customer only with the price grain.',
  },
  'samples.manage': {
    risk: 'write',
    description: 'Ask for sample rounds, change them while open, move them on the board, cancel them with why, keep their shipments (courier, tracking, sent, received) and make their sample work orders (with workorders.manage at the making site).',
  },
})

export const SALES_SAMPLES_VIEW = 'sales.samples.view' satisfies Permission
export const SALES_SAMPLES_MANAGE = 'sales.samples.manage' satisfies Permission

export const SALES_SAMPLES_PERMISSIONS: readonly Permission[] = Object.freeze([SALES_SAMPLES_VIEW, SALES_SAMPLES_MANAGE])

/**
 * Who holds them (auth/roles/templates; the owner from every()): sales owns the rounds and their shipments; the production
 * manager runs the sample room (rounds and their work orders); the planner and the quality inspector (CE test samples) read
 * them.
 */
export const SALES_SAMPLES_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  sales: [SALES_SAMPLES_VIEW, SALES_SAMPLES_MANAGE],
  production_manager: [SALES_SAMPLES_VIEW, SALES_SAMPLES_MANAGE],
  planner: [SALES_SAMPLES_VIEW],
  quality_inspector: [SALES_SAMPLES_VIEW],
})
