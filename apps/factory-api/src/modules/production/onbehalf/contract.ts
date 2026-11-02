import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { OVERRIDE_REASON_CODES } from '@nexus/factory-domain/production/guards/rules'
import { ON_BEHALF_REASON_CODES, SEVERAL_LIMITS } from '@nexus/factory-domain/production/onbehalf/rules'
import { SCAN_SUBJECTS } from '@nexus/factory-domain/production/settings/monitoring'
import { reportContract } from '../scans/contract'

/**
 * Scan on behalf and several bundles at once (B-W2b-47; MES-099, MES-100). A report entered on behalf is the scans' report
 * with the station picked, the person (where the site names workers), a reason tile and its note; a refusal is the scans'
 * 409 (`refusal/<CODE>`, with BEHALF_… codes of its own). No field carries money. People are named only for the team leader
 * who holds production.scan.behalf, in its own picker.
 */

const scanAnswer = reportContract.response[201]

export const onBehalfBody = reportContract.body.extend({
  /** Where the work was done. */
  stationId: id(),
  /** The person who did it: required where the site names workers, absent where it records the station. */
  workerId: id().optional(),
  reasonCode: z.enum(ON_BEHALF_REASON_CODES),
  /** A few words; required with OTHER. */
  note: z.string().trim().min(3).max(200).optional(),
})

export const optionsContract = defineContract({
  response: {
    200: output({
      subject: z.enum(SCAN_SUBJECTS),
      stations: z.array(output({ id: id(), code: z.string(), name: z.string(), lineId: id().nullable() })),
      /** The people who may be named (their notice in force acknowledged), the team leader left out; empty where the site records stations. */
      people: z.array(output({ id: id(), name: z.string() })),
      reasons: z.array(output({ code: z.enum(ON_BEHALF_REASON_CODES), label: output({ it: z.string(), en: z.string() }), needsNote: z.boolean() })),
    }),
  },
})

export const onBehalfContract = defineContract({ body: onBehalfBody, response: { 200: scanAnswer, 201: scanAnswer } })

export const onBehalfOverrideContract = defineContract({
  body: input({
    /** The held entry, as the tablet sent it (the same clientScanId). */
    report: onBehalfBody,
    /** ANOTHER team leader (four eyes): their badge, scanned, or their worker id, picked by name; and their 6-digit PIN (never stored, never logged). */
    lead: input({ badgeCode: z.string().trim().min(1).max(64).optional(), workerId: id().optional(), pin: z.string().regex(/^\d{6}$/, 'Expected 6 digits.') }),
    overrideReasonCode: z.enum(OVERRIDE_REASON_CODES),
    /** A few words; required with OTHER. */
    overrideNote: z.string().trim().min(3).max(200).optional(),
  }),
  response: { 200: scanAnswer, 201: scanAnswer },
})

const stackItem = reportContract.body.omit({ occurredAt: true })

export const severalBody = input({
  /** The stack in the order scanned: each bundle is its own report, under its own clientScanId. */
  items: z.array(stackItem).min(1).max(SEVERAL_LIMITS.maxBundles),
  /** When Finish was tapped, by the tablet's clock. */
  occurredAt: instant().optional(),
})

export const severalContract = defineContract({
  body: severalBody,
  response: {
    200: output({
      items: z.array(
        output({
          clientScanId: z.string(),
          status: z.enum(['accepted', 'duplicate', 'refused']),
          scan: scanAnswer.shape.scan.nullable(),
          /** A refused bundle stays on the stack: its code, words and one fix. */
          refusal: output({ code: z.string(), message: z.string(), fix: z.string(), final: z.boolean() }).nullable(),
        }),
      ),
      finished: z.number().int(),
      refused: z.number().int(),
      good: z.number().int(),
      scrap: z.number().int(),
      rework: z.number().int(),
      /** The receipt in words: "3 bundles finished · 60 good". */
      words: z.string(),
    }),
  },
})
