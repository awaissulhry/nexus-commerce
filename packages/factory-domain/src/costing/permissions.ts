import type { Permission } from '../core/permissions'
import { definePermissions } from '../auth/permissions/registry'

/**
 * Costing's permissions (apps/factory-api modules/costing; features FIN-001, FIN-002, FIN-004, GAP-006), in the costing
 * area. Checked with can() against the style's company (a tenant-wide style: the company the cost is asked for, else
 * every company the grant reaches).
 *
 * Reading a cost sheet is not seeing its figures: every cost figure is a `money.cost` field, dropped for a caller
 * without the cost grain (A1 §2.6), so a sales person or a production manager may see which inputs are missing and the
 * minutes and quantities behind a cost, never the cost. Floor, portal and link sessions never reach these routes.
 */
export const COSTING_DEFINITIONS = definePermissions('costing', {
  view: {
    risk: 'read',
    description:
      "See a style revision's cost sheet: material from the BOM per size and colourway at each material's standard purchase price, labour from the routing's standard minutes, overhead, the waterfall, what is missing and the inputs used; compare two revisions; cost a quote's cells; see the labour rates and costing settings. Figures only with the cost grain.",
  },
  'rates.manage': {
    risk: 'write',
    description: 'Keep the cost per standard minute of each kind of work centre (tenant-wide or per company, from a day; correct and archive them) and the overhead percentage. Sending a rate needs the cost grain.',
  },
  // B-W2a-21 (standard vs actual; FIN-024, FIN-025, FIN-026, FIN-027, FIN-033, FIN-038). Reading them is costing.view.
  'standards.manage': {
    risk: 'write',
    description:
      "Prepare, correct, discard and freeze an item's standard cost for a period (a material's purchase standard, a finished garment's from its cost sheet). Freezing ends the standard before it and values the finished-goods receipts that waited for one. Sending a figure needs the cost grain.",
  },
  'ledger.manage': {
    risk: 'write',
    description: "Post a work order's cost ledger now (material issued and returned, scrap, labour earned by its scans, finished garments into stock) and reverse a wrong entry with a reason; an entry is never edited.",
  },
  'method.manage': {
    risk: 'stepUp',
    description: "Choose a company's costing method (standard, moving average or FIFO: the accountant's choice, c.c. art. 2426). It locks with the first cost entry posted under it and never changes after.",
  },
})

export const COSTING_VIEW = 'costing.view' satisfies Permission
export const COSTING_RATES_MANAGE = 'costing.rates.manage' satisfies Permission
export const COSTING_STANDARDS_MANAGE = 'costing.standards.manage' satisfies Permission
export const COSTING_LEDGER_MANAGE = 'costing.ledger.manage' satisfies Permission
export const COSTING_METHOD_MANAGE = 'costing.method.manage' satisfies Permission
export const COSTING_PERMISSIONS: readonly Permission[] = Object.freeze([COSTING_VIEW, COSTING_RATES_MANAGE, COSTING_STANDARDS_MANAGE, COSTING_LEDGER_MANAGE, COSTING_METHOD_MANAGE])
