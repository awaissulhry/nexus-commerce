import { z } from 'zod'
import { BATCH_NUMBER_MAX } from '@nexus/factory-domain/compliance/declarations/batches'
import { COVERAGE_KINDS, CELL_STATES } from '@nexus/factory-domain/compliance/declarations/coverage'
import { NAME_MAX, NOTE_MAX, NUMBER_MAX, PLACE_MAX, REASON_MAX, TRANSLATION_STATES, WORDS_MAX } from '@nexus/factory-domain/compliance/declarations/rules'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { ppeGateView } from '../ppe-texts/contract'

/**
 * The DoC generator's routes (B-W2b-257; PRD-292, PRD-293, PRD-295, PRD-300; design compliance.declarations). No price, no
 * cost, no pay figure anywhere; a person's name only inside one record (who checked a translation, who recorded a batch).
 */

const version = () => z.number().int().min(1)
const language = () => z.string().regex(/^[a-z]{2,3}$/)
const marketCode = () => z.string().regex(/^[A-Z]{2}(-[A-Za-z0-9]{1,8})*$/).max(40)
const person = output({ id: id(), name: z.string() })
const kind = z.enum(COVERAGE_KINDS)
const status = z.enum(['DRAFT', 'ISSUED', 'SUPERSEDED', 'WITHDRAWN'])
const origin = z.enum(['SIGNED', 'GENERATED'])
const source = output({ kind: z.string(), recordType: z.string().optional(), recordId: z.string().optional() })
const problem = output({ code: z.string(), point: z.string().nullable(), message: z.string() })
const wording = output({ key: z.string(), kind: z.enum(['PHRASE', 'TEMPLATE']), phraseId: z.string().optional(), revision: z.number().int().optional() })
const value = output({ field: z.string(), value: z.string(), source, sourceWords: z.string() })
const point = output({ point: z.string(), text: z.string(), source, sourceWords: z.string(), wording: wording.nullable(), values: z.array(value) })
const gate = output({ name: z.literal('GATE-PPE-TEXTS'), words: z.string() })

export const declarationRow = output({
  id: id(),
  styleId: id(),
  style: output({ code: z.string(), name: z.string() }),
  companyId: id().nullable(),
  kind,
  language: z.string(),
  revision: z.number().int(),
  number: z.string().nullable(),
  status,
  origin,
  translationOfId: id().nullable(),
  translationStatus: z.enum(TRANSLATION_STATES).nullable(),
  translationCheckedAt: instant().nullable(),
  translationCheckedBy: person.nullable(),
  marketCode: z.string().nullable(),
  certificate: output({ id: id(), number: z.string() }).nullable(),
  /** The maker as printed: the brand that sells under its own name (BRAND), else our company. */
  maker: output({ name: z.string(), address: z.string(), partyId: id().nullable(), role: z.enum(['COMPANY', 'BRAND']) }),
  standards: z.array(z.string()),
  signedByName: z.string().nullable(),
  signedByFunction: z.string().nullable(),
  signedPlace: z.string().nullable(),
  signedOn: businessDate().nullable(),
  issuedAt: instant().nullable(),
  /** Batches and shipments recorded under it (PRD-295). */
  batches: z.number().int(),
  shipments: z.number().int(),
  /** The switched-on markets whose languages need it. */
  marketsNeeding: z.array(z.string()),
  /** A generated document: a draft until GATE-PPE-TEXTS. */
  draftUntilChecked: z.boolean(),
  /** A translation's points still holding the original's words or words to type. */
  pointsToType: z.array(z.string()),
  version: z.number().int(),
  createdAt: instant(),
  updatedAt: instant(),
})

const timelineGroup = output({
  revision: z.number().int(),
  documents: z.array(output({ id: id(), kind: z.string(), language: z.string(), revision: z.number().int(), number: z.string().nullable(), status: z.string() })),
  batches: z.array(
    output({
      batchNumber: z.string(),
      workOrderId: id().nullable(),
      shipmentIds: z.array(id()),
      documentIds: z.array(id()),
      firstRecordedAt: instant(),
      shipments: z.array(output({ id: id(), number: z.string() })).optional(),
    }),
  ),
})

export const declarationDetail = declarationRow.extend({
  points: z.array(point),
  template: z.string().nullable(),
  // B-W2b-288 (FU2:01): the gate as the PPE consultant's yes per template says it (modules/compliance/ppe-texts).
  gate: ppeGateView.nullable(),
  createdBy: person.nullable(),
  original: output({ id: id(), language: z.string(), status }).nullable(),
  languages: z.array(output({ id: id(), language: z.string(), status, origin, translationStatus: z.enum(TRANSLATION_STATES).nullable(), translationCheckedBy: person.nullable(), marketCode: z.string().nullable(), pointsToType: z.array(z.string()), original: z.boolean() })),
  /** A generated draft against today's records: the points that differ (typed points never), what would refuse a refresh. */
  stale: output({ differences: z.array(output({ point: z.string(), stored: z.string().nullable(), fresh: z.string().nullable() })), problems: z.array(problem) }).nullable(),
  problems: z.array(problem),
  batches: z.array(timelineGroup),
  /** The style's public DoC address (B-W2b-166); live once a signed DoC is issued. */
  publication: output({ styleCode: z.string(), address: z.string(), live: z.boolean() }).nullable(),
  may: output({ edit: z.boolean(), refresh: z.boolean(), translate: z.boolean(), check: z.boolean(), withdraw: z.boolean() }),
})

const documentParams = input({ documentId: id() })
const detailAnswer = output({ declaration: declarationDetail })

export const listContract = defineContract({
  querystring: input({
    styleId: id().optional(),
    kind: kind.optional(),
    origin: origin.optional(),
    status: status.optional(),
    language: language().optional(),
    q: z.string().trim().min(1).max(100).optional(),
    limit: z.coerce.number().int().min(1).max(500).optional(),
  }),
  response: { 200: output({ declarations: z.array(declarationRow), more: z.boolean(), asOf: instant(), gate }) },
})

export const coverageContract = defineContract({
  querystring: input({ styleId: id().optional() }),
  response: {
    200: output({
      languages: z.array(z.string()),
      rows: z.array(
        output({
          style: output({ id: id(), code: z.string(), name: z.string(), revision: z.number().int().nullable() }),
          kind,
          cells: z.array(output({ language: z.string(), state: z.enum(CELL_STATES), documentId: id().nullable(), revision: z.number().int().nullable(), markets: z.array(z.string()) })),
        }),
      ),
      tiles: output({ issued: z.number().int(), drafts: z.number().int(), languagesMissing: z.number().int(), supersededIn30Days: z.number().int(), batchesShippedWithoutVersion: z.number().int() }),
      asOf: instant(),
      gate,
    }),
  },
})

export const previewContract = defineContract({
  querystring: input({ styleId: id(), revisionId: id().optional(), companyId: id().optional(), language: language(), marketCode: marketCode().optional() }),
  response: {
    200: output({
      preview: output({
        style: output({ id: id(), code: z.string(), name: z.string(), ppeCategory: z.string() }),
        revision: output({ id: id(), revision: z.number().int(), status: z.string() }).nullable(),
        companyId: id().nullable(),
        language: z.string(),
        number: z.string().nullable(),
        maker: output({ name: z.string(), address: z.string(), partyId: id().nullable(), sourceWords: z.string() }).nullable(),
        certificate: output({ id: id(), number: z.string(), body: z.string(), bodyNumber: z.string() }).nullable(),
        standards: z.array(z.string()),
        points: z.array(point),
        blocking: z.array(problem),
        warnings: z.array(problem),
        missingPhrases: z.array(z.string()),
        existing: output({ id: id(), status: z.string() }).nullable(),
      }),
    }),
  },
})

export const getContract = defineContract({ params: documentParams, response: { 200: detailAnswer } })
/** A generated draft's PDF, painted now (application/pdf, inline). */
export const pdfContract = defineContract({ params: documentParams, response: {} })

export const createContract = defineContract({
  body: input({
    styleId: id(),
    revisionId: id().optional(),
    /** For a style of every company: the company whose declaration it is (the maker, for our styles). */
    companyId: id().optional(),
    /** The original's language first, then its translations'. */
    languages: z.array(language()).min(1).max(10),
    marketCode: marketCode().nullable().optional(),
  }),
  response: { 201: detailAnswer },
})

const pointEdit = input({ point: z.string().regex(/^[1-9]$/), text: z.string().min(1).max(WORDS_MAX) })
const words = (max: number) => z.string().trim().min(1).max(max)

export const editContract = defineContract({
  params: documentParams,
  body: input({
    version: version(),
    points: z.array(pointEdit).max(9).optional(),
    number: words(NUMBER_MAX).nullable().optional(),
    signedByName: words(NAME_MAX).nullable().optional(),
    signedByFunction: words(NAME_MAX).nullable().optional(),
    signedPlace: words(PLACE_MAX).nullable().optional(),
    signedOn: businessDate().nullable().optional(),
    marketCode: marketCode().nullable().optional(),
  }),
  response: { 200: detailAnswer },
})

export const refreshContract = defineContract({ params: documentParams, body: input({ version: version(), keepTyped: z.boolean().optional() }), response: { 200: detailAnswer } })
export const withdrawContract = defineContract({ params: documentParams, body: input({ version: version(), reason: z.string().min(1).max(REASON_MAX) }), response: { 200: detailAnswer } })
export const translationsContract = defineContract({ params: documentParams, body: input({ languages: z.array(language()).min(1).max(10) }), response: { 201: detailAnswer } })
export const translationStateContract = defineContract({ params: documentParams, body: input({ version: version(), state: z.enum(['DRAFT', 'IN_TRANSLATION']) }), response: { 200: detailAnswer } })
export const checkContract = defineContract({ params: documentParams, body: input({ version: version() }), response: { 200: detailAnswer } })

// ---- versions by batch ----------------------------------------------------------------------------------------------------------

const recordView = output({
  id: id(),
  companyId: id(),
  style: output({ id: id(), code: z.string() }),
  document: output({ id: id(), kind: z.string(), language: z.string(), revision: z.number().int(), number: z.string().nullable(), status: z.string() }).nullable(),
  batchNumber: z.string(),
  workOrder: output({ id: id(), number: z.string() }).nullable(),
  shipment: output({ id: id(), number: z.string() }).nullable(),
  retainUntil: businessDate(),
  note: z.string().nullable(),
  createdAt: instant(),
  createdBy: person.nullable(),
})

export const batchesContract = defineContract({
  querystring: input({ styleId: id().optional(), batchNumber: z.string().trim().min(1).max(BATCH_NUMBER_MAX).optional(), workOrderId: id().optional(), shipmentId: id().optional() }),
  response: { 200: output({ records: z.array(recordView), timeline: z.array(timelineGroup).nullable(), asOf: instant() }) },
})

export const recordBatchContract = defineContract({
  body: input({
    documentId: id(),
    workOrderId: id().optional(),
    batchNumber: z.string().min(1).max(BATCH_NUMBER_MAX).optional(),
    shipmentId: id().optional(),
    companyId: id().optional(),
    note: z.string().min(1).max(NOTE_MAX).nullable().optional(),
  }),
  response: { 201: output({ record: recordView }) },
})

const shipmentParams = input({ shipmentId: id() })

export const recordShipmentContract = defineContract({
  params: shipmentParams,
  response: { 200: output({ recorded: z.array(recordView), skipped: z.array(output({ batchNumber: z.string(), documentId: id(), message: z.string() })) }) },
})

export const unrecordedContract = defineContract({
  response: {
    200: output({
      unrecorded: z.array(output({ shipmentId: id(), shipmentNumber: z.string(), shippedAt: instant().nullable(), workOrderId: id(), workOrderNumber: z.string(), batchNumber: z.string(), styleId: id(), styleCode: z.string() })),
      asOf: instant(),
    }),
  },
})

// ---- the shipment compliance pack ------------------------------------------------------------------------------------------------

const packFile = output({ id: id(), originalName: z.string(), sha256: z.string(), sizeBytes: z.number().int() })
const packVersion = output({
  id: id(),
  version: z.number().int(),
  language: z.string(),
  number: z.string().nullable(),
  fingerprint: z.string(),
  file: packFile.nullable(),
  shared: z.boolean(),
  documents: z.number().int(),
  createdAt: instant(),
  createdBy: person.nullable(),
})

export const packContract = defineContract({
  params: shipmentParams,
  response: {
    200: output({
      pack: output({
        shipment: output({ id: id(), number: z.string(), status: z.string(), shippedOn: businessDate().nullable() }),
        customer: output({ name: z.string() }).nullable(),
        order: output({ number: z.string(), customerRef: z.string().nullable() }).nullable(),
        wantedLanguage: z.string().nullable(),
        day: businessDate(),
        locale: z.enum(['it', 'en']),
        styles: z.array(
          output({
            styleId: id(),
            code: z.string(),
            name: z.string(),
            revision: z.number().int().nullable(),
            category: z.string(),
            garments: z.number().int(),
            documents: z.array(output({ documentId: id(), kind, language: z.string(), revision: z.number().int(), number: z.string().nullable(), issuedAt: z.string().nullable(), fallback: z.boolean(), file: packFile })),
            certificate: output({ id: id(), number: z.string(), standard: z.string(), ppeClass: z.string().nullable(), bodyName: z.string(), bodyNumber: z.string(), validFrom: businessDate(), validTo: businessDate(), validOnDay: z.boolean() }).nullable(),
            batches: z.array(output({ workOrderId: id(), batchNumber: z.string(), garments: z.number().int(), publicDocAddress: z.string(), publicDocCode: z.string() })),
          }),
        ),
        contents: z.array(output({ title: z.string(), sha256: z.string(), recordType: z.string(), recordId: id(), fileId: id(), path: z.string() })),
        refusals: z.array(output({ code: z.string(), message: z.string() })),
        warnings: z.array(output({ code: z.string(), message: z.string() })),
        versions: z.array(packVersion),
      }),
    }),
  },
})

const packAnswer = output({ pack: output({ version: packVersion, made: z.boolean() }) })
export const makePackContract = defineContract({ params: shipmentParams, body: input({ share: z.boolean().optional() }), response: { 200: packAnswer, 201: packAnswer } })
/** One version's PDF (inline) or ZIP (attachment). */
export const packFileContract = defineContract({ params: input({ shipmentId: id(), documentId: id() }), response: {} })
