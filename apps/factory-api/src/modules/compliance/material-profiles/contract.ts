import { z } from 'zod'
import { INNOCUOUSNESS_PARAMETERS } from '@nexus/factory-domain/compliance/material-profiles/rules'
import { DECLARATION_KINDS, SUBSTANCE_TESTS } from '@nexus/factory-domain/compliance/substances/rules'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'

/**
 * Material profiles (B-W2b-256; PRD-303, PRD-314; design compliance.tests › Material profiles, the material record's
 * Compliance tab). Materials by code and name, compositions, tannages, countries, states and their reasons, tests and
 * declarations by kind, lab results against their limits, file names; people by their name where they confirmed. No price,
 * no cost, no lab price.
 */

const state = z.enum(['INCOMPLETE', 'COMPLETE', 'BLOCKED'])
const parameter = z.enum(INNOCUOUSNESS_PARAMETERS)
const parameterStatus = z.enum(['MET', 'FAILED', 'FILE', 'MISSING'])
const person = output({ id: id(), name: z.string() }).nullable()

const profileRow = output({
  material: output({ id: id(), code: z.string(), name: z.string(), kind: z.string(), companyId: id().nullable(), status: z.string() }),
  /** "80 % polyester, 20 % elastane". */
  composition: z.string().nullable(),
  tannage: z.string().nullable(),
  animalSpecies: z.string().nullable(),
  originCountry: z.string().nullable(),
  supplier: output({ id: id(), code: z.string(), name: z.string() }).nullable(),
  /** The saved state (null: never evaluated, no profile yet). */
  state: state.nullable(),
  stateReason: z.string().nullable(),
  evaluatedAt: instant().nullable(),
  /** Required tests (from the rules, as the evaluator last wrote them). */
  testsNeeded: z.array(z.enum(SUBSTANCE_TESTS)),
  /** Declarations needed, present (accepted and valid today), missing, asked and not decided. */
  declarations: output({ needed: z.array(z.enum(DECLARATION_KINDS)), present: z.array(z.enum(DECLARATION_KINDS)), missing: z.array(z.enum(DECLARATION_KINDS)), asked: z.array(z.enum(DECLARATION_KINDS)) }),
  compositionConfirmed: z.boolean(),
  /** LEATHER only (null otherwise). */
  tannageConfirmed: z.boolean().nullable(),
  /** EN ISO 13688 innocuousness (pH, Cr VI, azo, nickel as the kind needs): required when a PPE style uses the material. */
  innocuousness: output({ required: z.boolean(), complete: z.boolean(), parameters: z.array(output({ parameter, status: parameterStatus })) }),
  svhcAboveThreshold: z.boolean().nullable(),
  version: z.number().int().nullable(),
})

const profileRecord = profileRow.extend({
  compositionList: z.array(output({ fibre: z.string(), percent: z.string() })),
  isPpeComponent: z.boolean(),
  requiresCrViTest: z.boolean(),
  compositionConfirmedAt: instant().nullable(),
  compositionConfirmedBy: person,
  tannageConfirmedAt: instant().nullable(),
  tannageConfirmedBy: person,
  note: z.string().nullable(),
  /** What keeps it INCOMPLETE beyond the rules (confirmations, innocuousness), in words. */
  gaps: z.array(z.string()),
  innocuousnessDetail: output({
    required: z.boolean(),
    ppeStyles: z.array(z.string()),
    complete: z.boolean(),
    parameters: z.array(
      output({
        parameter,
        words: z.string(),
        status: parameterStatus,
        result: output({ resultId: id(), lotId: id(), test: z.string(), verdict: z.enum(['PASS', 'FAIL']), testedOn: businessDate() }).nullable(),
        files: z.array(id()),
        explanation: z.string(),
      }),
    ),
  }),
  evidenceFiles: z.array(output({ fileId: id(), name: z.string(), category: z.string().nullable(), expiresOn: businessDate().nullable() })),
  declarationRequests: z.array(
    output({
      requestId: id(),
      number: z.string(),
      kind: z.enum(DECLARATION_KINDS),
      status: z.string(),
      party: output({ id: id().nullable(), code: z.string() }),
      dueOn: businessDate(),
      validTo: businessDate().nullable(),
      lines: z.array(output({ contains: z.boolean().nullable(), aboveThreshold: z.boolean().nullable(), substanceName: z.string().nullable() })),
    }),
  ),
  labResults: z.array(
    output({
      resultId: id(),
      lot: output({ id: id(), code: z.string() }),
      test: z.string(),
      verdict: z.string(),
      testedOn: businessDate(),
      value: z.string().nullable(),
      belowDetectionLimit: z.boolean(),
      unit: z.string(),
      limit: z.string(),
      method: z.string(),
      lab: z.string(),
      current: z.boolean(),
    }),
  ),
  /** Where its evidence files go (POST /files with this record). */
  evidenceRecord: output({ recordType: z.string(), recordId: id() }),
  mayEdit: z.boolean(),
})

export const listProfilesContract = defineContract({
  querystring: input({
    state: z.enum(['INCOMPLETE', 'COMPLETE', 'BLOCKED', 'NONE']).optional(),
    kind: z.string().trim().regex(/^[A-Z]{2,20}$/).optional(),
    q: z.string().trim().min(1).max(100).optional(),
  }),
  response: {
    200: output({
      profiles: z.array(profileRow),
      more: z.boolean(),
      /** The tiles: every active material, never evaluated, incomplete, complete, blocked. */
      counts: output({ materials: z.number().int(), none: z.number().int(), incomplete: z.number().int(), complete: z.number().int(), blocked: z.number().int() }),
      mayEdit: z.boolean(),
      asOf: instant(),
    }),
  },
})

const params = input({ itemId: id() })

export const getProfileContract = defineContract({ params, response: { 200: output({ profile: profileRecord, asOf: instant() }) } })

export const editProfileContract = defineContract({
  params,
  body: input({
    version: z.number().int().min(1).optional(),
    compositionConfirmed: z.boolean().optional(),
    tannageConfirmed: z.boolean().optional(),
    /** ISO 3166-1 alpha-2 ("IT"); null clears it. */
    originCountry: z.string().trim().max(40).nullable().optional(),
    note: z.string().max(1000).nullable().optional(),
  }),
  response: { 200: output({ profile: profileRecord, changed: z.array(z.enum(['COMPOSITION', 'TANNAGE', 'ORIGIN', 'NOTE'])), at: instant() }) },
})
