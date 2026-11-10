import { z } from 'zod'
import { COMPLIANCE_GATES, FIX_PLACES, WHO } from '@nexus/factory-domain/compliance/requirements/rules'
import { LINE_STATES } from '@nexus/factory-domain/compliance/gates/gate'
import { CELL_STATES } from '@nexus/factory-domain/compliance/status/board'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'

/**
 * The compliance status board's reads (B-W2b-254; PRD-277; design compliance.status SCR-119). Codes, states, counts of
 * things (never of people), words. No price, no cost.
 */

const gate = z.enum(COMPLIANCE_GATES)
const check = z.string()
const first = output({ code: z.string(), message: z.string(), fix: z.string().nullable(), who: z.enum(WHO), fixPlace: z.enum(FIX_PLACES), legalReference: z.string() }).nullable()
const cell = output({
  marketCode: z.string(),
  state: z.enum(CELL_STATES),
  /** "Ready", "Missing 2", "Blocked", "Expiring" (screens say their own words per state). */
  words: z.string(),
  missing: z.number().int(),
  blocking: z.number().int(),
  expiring: z.number().int(),
  manual: z.number().int(),
  blockedGates: z.array(gate),
  first,
})
const action = output({ styleId: id(), styleCode: z.string(), marketCode: z.string(), requirementCode: z.string(), words: z.string(), who: z.enum(WHO), fixPlace: z.enum(FIX_PLACES), severity: z.enum(['BLOCKED', 'MISSING', 'EXPIRING']) })
const boardQuery = {
  companyId: id().optional(),
  /** "IT,DE": the markets asked (default: the switched-on ones). */
  markets: z.string().trim().max(400).optional(),
  q: z.string().trim().min(1).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
}

export const boardContract = defineContract({
  querystring: input(boardQuery),
  response: {
    200: output({
      markets: z.array(output({ code: z.string(), name: z.string(), switchedOn: z.boolean() })),
      tiles: output({
        stylesReady: z.number().int(),
        stylesBlocked: z.number().int(),
        certificatesExpiring90: z.number().int(),
        /** null: not counted here (B-W2b-256's material profiles). */
        lotsWithoutCrVi: z.number().int().nullable(),
        missingLanguages: z.number().int(),
        shipmentsHeld: z.number().int(),
      }),
      rows: z.array(
        output({
          style: output({ id: id(), code: z.string(), name: z.string(), companyId: id().nullable(), ppeCategory: z.string(), productType: z.string(), brand: output({ id: id(), code: z.string(), name: z.string() }).nullable(), soldUnderOurName: z.boolean() }),
          cells: z.array(cell),
          ready: z.boolean(),
          blocked: z.boolean(),
        }),
      ),
      /** More styles than the limit: narrow by company or search. */
      more: z.boolean(),
      needsAction: output({ lines: z.array(action), count: z.number().int() }),
      asOf: instant(),
    }),
  },
})

export const actionsContract = defineContract({
  querystring: input(boardQuery),
  response: { 200: output({ lines: z.array(action), count: z.number().int(), asOf: instant() }) },
})

export const cellContract = defineContract({
  querystring: input({ styleId: id(), market: z.string().trim().min(2).max(40) }),
  response: {
    200: output({
      style: output({ id: id(), code: z.string(), name: z.string(), ppeCategory: z.string(), productType: z.string() }),
      market: output({ code: z.string(), name: z.string(), switchedOn: z.boolean() }),
      cell,
      items: z.array(
        output({
          requirement: output({ id: id().nullable(), code: z.string(), name: z.string(), nameI18n: z.record(z.string(), z.string()), legalReference: z.string(), explanationI18n: z.record(z.string(), z.string()), blocks: z.array(gate), lockedBlocks: z.array(gate) }),
          check,
          state: z.enum(LINE_STATES),
          message: z.string(),
          fix: z.string().nullable(),
          evidence: output({ recordType: z.string(), recordId: id(), label: z.string() }).nullable(),
          who: z.enum(WHO),
          fixPlace: z.enum(FIX_PLACES),
        }),
      ),
      asOf: instant(),
    }),
  },
})

export const expiriesContract = defineContract({
  querystring: input({ months: z.coerce.number().int().min(1).max(24).optional() }),
  response: {
    200: output({
      months: z.array(output({ month: z.string(), count: z.number().int(), items: z.array(output({ recordType: z.string(), recordId: id(), label: z.string(), validTo: businessDate() })) })),
      count: z.number().int(),
      from: businessDate(),
      to: businessDate(),
      asOf: instant(),
    }),
  },
})
