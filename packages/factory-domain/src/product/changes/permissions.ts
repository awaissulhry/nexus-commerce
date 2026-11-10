import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * Change requests and change orders (B-W2b-226; PRD-169, PRD-170, PRD-175, MES-006; design products.changes), in the
 * product area, office only. Each is checked with can() against the record's company (a tenant-wide style's request or
 * order is numbered in a company and checked there). A floor device reports a spec problem with floor.work at its own site
 * (every floor role): it reads no request, not even its own (the database grants the floor INSERT only).
 *
 *   product.changes.view      read change requests and change orders: what, why, from where, the revisions, the lines,
 *                             the approvals, the affected work orders
 *   product.changes.request   raise a change request from the office (for itself, a customer, a sample round or a
 *                             supplier, maybe from a work order already released) and add its photos
 *   product.changes.manage    triage requests (review, accept, reject) and write change orders: lines, work in progress,
 *                             approvers, the proposed revision, submit, cancel, release
 *   product.changes.approve   decide a change order one is named on (approve, or reject with why); never one's own
 *
 * Four eyes are two people, never two permissions: the database refuses an approver who is the change order's author.
 * Starting the draft revision and releasing it also ask the BOM's own permissions (product.bom.manage, product.bom.release):
 * the redlines are a real revision of the style.
 */
export const PRODUCT_CHANGES_DEFINITIONS = definePermissions('product', {
  'changes.view': {
    risk: 'read',
    description: 'See change requests and change orders: what should change and why, where it came from (office, floor, customer, sample, supplier), the revisions old and new, what each change touches, the work orders in progress and the approvals.',
  },
  'changes.request': {
    risk: 'write',
    description: 'Raise a change request for a style from the office (for itself, a customer, a sample round or a supplier, or from a released work order) with photos.',
  },
  'changes.manage': {
    risk: 'write',
    description: 'Triage change requests (review, accept or reject with why) and write change orders: what each change touches, what happens to each open work order, the approvers, the proposed revision; submit, cancel and release them.',
  },
  'changes.approve': {
    risk: 'write',
    description: 'Approve or reject (with why) a change order one is named to decide. Never one’s own change order (four eyes).',
  },
})

export const PRODUCT_CHANGES_VIEW = 'product.changes.view' satisfies Permission
export const PRODUCT_CHANGES_REQUEST = 'product.changes.request' satisfies Permission
export const PRODUCT_CHANGES_MANAGE = 'product.changes.manage' satisfies Permission
export const PRODUCT_CHANGES_APPROVE = 'product.changes.approve' satisfies Permission

export const PRODUCT_CHANGES_PERMISSIONS: readonly Permission[] = Object.freeze([PRODUCT_CHANGES_VIEW, PRODUCT_CHANGES_REQUEST, PRODUCT_CHANGES_MANAGE, PRODUCT_CHANGES_APPROVE])

/**
 * Who holds them (auth/roles/templates; the owner from every()): the production manager keeps the styles and runs change
 * orders end to end; quality raises requests and approves; sales (customers' requests), the planner, the buyer (a
 * supplier's material changed) and the floor supervisor's office account raise and read them.
 */
export const PRODUCT_CHANGES_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  production_manager: [PRODUCT_CHANGES_VIEW, PRODUCT_CHANGES_REQUEST, PRODUCT_CHANGES_MANAGE, PRODUCT_CHANGES_APPROVE],
  quality_inspector: [PRODUCT_CHANGES_VIEW, PRODUCT_CHANGES_REQUEST, PRODUCT_CHANGES_APPROVE],
  sales: [PRODUCT_CHANGES_VIEW, PRODUCT_CHANGES_REQUEST],
  planner: [PRODUCT_CHANGES_VIEW, PRODUCT_CHANGES_REQUEST],
  buyer: [PRODUCT_CHANGES_VIEW, PRODUCT_CHANGES_REQUEST],
  floor_supervisor: [PRODUCT_CHANGES_VIEW, PRODUCT_CHANGES_REQUEST],
})
