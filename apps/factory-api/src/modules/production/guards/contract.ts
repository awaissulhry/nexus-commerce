import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { FLOOR_RULE_MODES, GUARD_KINDS, OVERRIDE_REASON_CODES } from '@nexus/factory-domain/production/guards/rules'
import { reportContract } from '../scans/contract'

/**
 * Checks before a scan counts (B-W2b-46; MES-070, MES-097, MES-098, MES-114). Counts are garments. No field carries
 * money; no floor answer names a person; the office's list names none either (Statuto dei Lavoratori art. 4): only one
 * record (`GET /production/guards/flags/:scanId`) names the scan's worker (where the site names workers) and the team
 * leader who overrode. A held report is the scans' 409 (`refusal/<CODE>`, W1's words for a skipped operation and more
 * than passed); the codes a team leader may override are factory-domain production/guards OVERRIDABLE_REFUSALS.
 */

const mode = z.enum(FLOOR_RULE_MODES)
const guardKind = z.enum(GUARD_KINDS)
const operationRef = output({ id: id(), seq: z.number().int(), name: z.string() })
const ref = output({ id: id(), code: z.string() })
const component = output({ itemId: id(), itemCode: z.string(), lotId: id(), lotCode: z.string(), garments: z.number().int() })
const guardWords = output({ kind: guardKind, mode: z.string(), code: z.string(), message: z.string() })
const person = output({ id: id(), name: z.string() })

export const checkContract = defineContract({
  querystring: input({
    code: z.string().trim().min(1).max(60),
    workOrderOperationId: id().optional(),
    /** The counts on the pads, when the operator typed others than all good: their findings too (default: all good of what reached it). */
    good: z.coerce.number().int().min(0).max(100_000).optional(),
    scrap: z.coerce.number().int().min(0).max(100_000).optional(),
    rework: z.coerce.number().int().min(0).max(100_000).optional(),
  }),
  response: {
    200: output({
      bundle: output({ id: id(), code: z.string(), quantity: z.number().int() }),
      /** The site's rules (ProductionSettings): STRICT holds for a team leader's override, WARN tells, FREE lets it pass. */
      modes: output({ quantityGuard: mode, skippedOperationRule: mode }),
      /** The operation (named, or the one this station does next), or null with the scans' hint (choose, nothing here). */
      operation: output({ id: id(), seq: z.number().int(), code: z.string(), name: z.string(), reported: z.boolean() }).nullable(),
      hint: output({ code: z.string(), message: z.string(), fix: z.string() }).nullable(),
      /** The garments that reached the operation: the last reported earlier operation's good, or the bundle's. */
      expected: z.number().int().nullable(),
      /** The counts are more than the bundle's own (live) garments: refused, never overridden. */
      beyondBundle: z.boolean(),
      skipped: z.array(operationRef),
      /** What holds (STRICT) or warns (WARN) an all-good report here already: the line, a skipped operation, a late report. */
      findings: z.array(output({ kind: guardKind, mode: z.enum(['WARN', 'STRICT']), code: z.string(), message: z.string(), fix: z.string(), overridable: z.boolean() })),
      /** MES-114: the components the operation asks (rows to tick) and the cell's lot-traced materials that may be scanned. */
      components: output({ asked: z.array(output({ itemId: id(), code: z.string(), name: z.string() })), traceable: z.array(output({ itemId: id(), code: z.string(), name: z.string(), asked: z.boolean() })) }),
      /** The override's reason tiles. */
      overrideReasons: z.array(output({ code: z.enum(OVERRIDE_REASON_CODES), label: output({ it: z.string(), en: z.string() }), needsNote: z.boolean() })),
    }),
  },
})

const answer = reportContract.response[201].extend({
  /** What the team leader overrode, or null: nothing held the report any more when it was sent. */
  override: output({ guards: z.array(guardKind), reasonCode: z.enum(OVERRIDE_REASON_CODES) }).nullable(),
})

export const overrideContract = defineContract({
  body: input({
    /** The held report, as the tablet sent it (the same clientScanId). */
    report: reportContract.body,
    /** The team leader: their badge, scanned, or their worker id, picked by name; and their 6-digit PIN (never stored, never logged). */
    lead: input({ badgeCode: z.string().trim().min(1).max(64).optional(), workerId: id().optional(), pin: z.string().regex(/^\d{6}$/, 'Expected 6 digits.') }),
    reasonCode: z.enum(OVERRIDE_REASON_CODES),
    /** A few words; required with OTHER. */
    note: z.string().trim().min(3).max(200).optional(),
  }),
  response: { 200: answer, 201: answer },
})

const flagRow = output({
  scanId: id(),
  at: instant(),
  siteId: id().nullable(),
  kind: z.enum(['WARNED', 'OVERRIDDEN']),
  guards: z.array(guardKind),
  workOrder: output({ id: id(), number: z.string() }),
  bundle: ref,
  operation: operationRef,
  station: ref.nullable(),
  /** The skipped operations still not reported for the bundle (0: reported since, it settled by itself). */
  stillSkipped: z.number().int(),
})

export const flagsContract = defineContract({
  querystring: input({
    siteId: id().optional(),
    /** The site's day (its wall clock); default: today. */
    date: businessDate().optional(),
    kind: z.enum(['WARNED', 'OVERRIDDEN']).optional(),
    guard: guardKind.optional(),
    limit: z.coerce.number().int().min(1).max(500).default(200),
  }),
  response: { 200: output({ date: z.string().nullable(), flags: z.array(flagRow) }) },
})

export const flagContract = defineContract({
  params: input({ scanId: id() }),
  response: {
    200: output({
      flag: output({
        scanId: id(),
        at: instant(),
        workOrder: output({ id: id(), number: z.string() }),
        bundle: ref,
        operation: operationRef,
        counts: output({ good: z.number().int(), scrap: z.number().int(), rework: z.number().int() }),
        station: ref.nullable(),
        /** The scan's worker, where the site names workers (one record). */
        worker: person.nullable(),
        warned: z.array(guardWords),
        overridden: output({ guards: z.array(guardWords), lead: person.nullable(), reasonCode: z.string(), reason: z.string(), note: z.string().nullable() }).nullable(),
        components: z.array(component),
      }),
    }),
  },
})

export const workOrderComponentsContract = defineContract({
  params: input({ workOrderId: id() }),
  response: {
    200: output({
      workOrder: output({ id: id(), number: z.string() }),
      traced: z.array(output({ scanId: id(), at: instant(), bundle: ref, operation: operationRef, garments: z.number().int(), components: z.array(component) })),
    }),
  },
})

export const lotGarmentsContract = defineContract({
  params: input({ lotId: id() }),
  response: {
    200: output({
      lot: output({ id: id(), code: z.string(), itemId: id() }),
      /** Every garment traced with this lot, together. */
      garments: z.number().int(),
      uses: z.array(output({ at: instant(), workOrder: output({ id: id(), number: z.string() }), bundle: ref, operation: operationRef, scanId: id(), garments: z.number().int() })),
    }),
  },
})
