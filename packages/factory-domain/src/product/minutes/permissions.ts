import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * SMV governance (B-W2b-215; PRD-113; design products.operations pop-up "Propose SMV change" with "Send for approval", the
 * "SMV changes waiting for approval" tile), in the product area. Each is checked with can() against the operation's company
 * (an operation of every company: a grant over every company). The approval is a person who did not propose the version
 * (four eyes, the database too): holding both permissions never lets one person change an SMV alone.
 *
 *   product.smv.propose   propose an SMV change: basic minutes and allowances, where they come from, from which day, why
 *   product.smv.approve   approve or reject someone else's proposal (with why)
 *
 * Reading an operation's minutes, its versions and the routing's times comes with product.routing.view; a draft routing
 * step's minutes (copy an approved version, allowances, set-up / wait / move, extra minutes per size) with
 * product.routing.manage (modules/product/minutes). An SMV feeds capacity, cost and, behind GATE-PIECE-PAY, piece rates.
 */
export const PRODUCT_SMV_DEFINITIONS = definePermissions('product', {
  'smv.propose': {
    risk: 'write',
    description:
      "Propose a change of an operation's standard minutes (SMV): basic minutes with personal, fatigue and delay allowances, where they come from (time study, predetermined times, estimate), the day it applies from and why. Another person approves it.",
  },
  'smv.approve': {
    risk: 'write',
    description:
      "Approve or reject (with why) an SMV change someone else proposed: once approved, the operation's SMV takes the new numbers on its day, for new routing steps, capacity, cost and piece rates. Never one's own proposal.",
  },
})

export const PRODUCT_SMV_PROPOSE = 'product.smv.propose' satisfies Permission
export const PRODUCT_SMV_APPROVE = 'product.smv.approve' satisfies Permission

export const PRODUCT_SMV_PERMISSIONS: readonly Permission[] = Object.freeze([PRODUCT_SMV_PROPOSE, PRODUCT_SMV_APPROVE])

/**
 * The office role templates that govern SMVs (roles/templates; the owner from every()): the production manager keeps the
 * operation library and its minutes (product.operations.manage) and both proposes and approves — four eyes are two
 * people, never two permissions. No other template keeps the library.
 */
export const SMV_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  production_manager: [PRODUCT_SMV_PROPOSE, PRODUCT_SMV_APPROVE],
})
