import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * Off-standard and indirect time (apps/factory-api modules/production/offstandard; B-W2b-29; features MES-155 … MES-158;
 * design production.settings "Off-standard codes", production.labour "Off-standard blocks to approve", floor.operation
 * "No bundle: what are you doing?"), in the production area, office only. Checked with can() against the code's company,
 * or the block's company and site. The floor works with its own floor permissions: `floor.work` starts and ends the
 * signed-in worker's (or the station's) block at the device's site, `floor.lead` lets a team leader approve or reject the
 * site's blocks with the PIN. Nothing here carries money: a pay rule is a rule, not an amount (pay reads it, behind its own
 * switch). No list here names a person or adds up a person's minutes (Statuto dei Lavoratori art. 4; Owner answers W1,
 * F2): a block names its worker only on its own record, and only where the site records workers.
 */
export const PRODUCTION_OFFSTANDARD_DEFINITIONS = definePermissions('production', {
  'offstandard.view': {
    risk: 'read',
    description:
      "See the off-standard and indirect codes with their pay rules, and the blocks of time not on standard work of the sites per line, station and code (one block names its worker only on its own record, where the site records workers).",
  },
  'offstandard.codes': {
    risk: 'write',
    description: "Keep the company's off-standard and indirect codes: words in each floor language, icon, colour, pay rule (average earnings, base hourly, unpaid), whether the team leader approves a block, order, and set a code inactive.",
  },
  'offstandard.approve': {
    risk: 'write',
    description:
      "Approve or reject blocks of off-standard time (never one's own), end a block left running, type a block afterwards for a worker or a station, and reopen or correct a block with a reason (before and after are kept).",
  },
})

export const PRODUCTION_OFFSTANDARD_VIEW = 'production.offstandard.view' satisfies Permission
export const PRODUCTION_OFFSTANDARD_CODES = 'production.offstandard.codes' satisfies Permission
export const PRODUCTION_OFFSTANDARD_APPROVE = 'production.offstandard.approve' satisfies Permission

export const PRODUCTION_OFFSTANDARD_PERMISSIONS: readonly Permission[] = Object.freeze([PRODUCTION_OFFSTANDARD_VIEW, PRODUCTION_OFFSTANDARD_CODES, PRODUCTION_OFFSTANDARD_APPROVE])
