import { z } from 'zod'
import { TRANSLATION_STATES } from '@nexus/factory-domain/compliance/declarations/rules'
import { PACK_STATES } from '@nexus/factory-domain/compliance/user-information/packs'
import { WORDS_MAX } from '@nexus/factory-domain/compliance/user-information/rules'
import { SECTION_KEYS } from '@nexus/factory-domain/compliance/user-information/template'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { declarationRow } from '../declarations/contract'

/**
 * The user information builder's routes (B-W2b-258; PRD-350 to PRD-354; design compliance.declarations, the user-information
 * kind). A leaflet's row is the DoC generator's declaration row (B-W2b-257), extended with what a leaflet holds. No price, no
 * cost, no pay figure anywhere; a person's name only inside one record (who made it, who checked a translation).
 */

const version = () => z.number().int().min(1)
const language = () => z.string().regex(/^[a-z]{2,3}$/)
const marketCode = () => z.string().regex(/^[A-Z]{2}(-[A-Za-z0-9]{1,8})*$/).max(40)
const person = output({ id: id(), name: z.string() })
const status = z.enum(['DRAFT', 'ISSUED', 'SUPERSEDED', 'WITHDRAWN'])
const origin = z.enum(['SIGNED', 'GENERATED'])
const source = output({ kind: z.string(), recordType: z.string().optional(), recordId: z.string().optional() })
const problem = output({ code: z.string(), point: z.string().nullable(), message: z.string() })
const wording = output({ key: z.string(), kind: z.enum(['PHRASE', 'TEMPLATE']), phraseId: z.string().optional(), revision: z.number().int().optional() })
const value = output({ field: z.string(), value: z.string(), source, sourceWords: z.string() })
const gate = output({ name: z.literal('GATE-PPE-TEXTS'), words: z.string() })

const section = output({ key: z.string(), text: z.string(), source, sourceWords: z.string(), wording: wording.nullable(), values: z.array(value) })
/** A section of a stored leaflet, with the Annex II point it answers (the screen's LawRef). */
const storedSection = section.extend({ law: z.string().nullable() })

/** PRD-353: a protector's place in the garment. */
const protectorPosition = output({
  zone: z.string(),
  pocket: z.string(),
  placementId: z.string(),
  seq: z.number().int(),
  protector: output({ id: z.string(), code: z.string(), name: z.string() }),
  standard: z.string(),
  level: z.string(),
  sizes: z.array(z.string()),
  note: z.string().nullable(),
})

/** PRD-354: a spare protector that fits, certified for its zones at their level. */
const spareProtector = output({
  name: z.string(),
  code: z.string(),
  itemId: z.string(),
  zones: z.array(z.string()),
  standard: z.string(),
  level: z.string(),
  certificate: output({ id: z.string(), number: z.string(), validTo: z.string() }),
  placed: z.boolean(),
})

const packDocument = output({
  id: id(),
  language: z.string(),
  revision: z.number().int(),
  status: z.string(),
  origin: z.string(),
  translationOfId: id().nullable(),
  translationStatus: z.string().nullable(),
  marketCode: z.string().nullable(),
  number: z.string().nullable(),
})

/** PRD-351: a market's language pack of one revision. */
const languagePack = output({
  market: output({ code: z.string(), name: z.string(), switchedOn: z.boolean() }),
  languages: z.array(output({ language: z.string(), state: z.enum(PACK_STATES), signed: packDocument.nullable(), generated: packDocument.nullable() })),
  live: z.boolean(),
  missing: z.array(z.string()),
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
      shipments: z.array(output({ id: id(), number: z.string() })),
    }),
  ),
})

export const leafletDetail = declarationRow.extend({
  sections: z.array(storedSection),
  protectorPositions: z.array(protectorPosition),
  spareProtectors: z.array(spareProtector),
  /** A translation's sections still holding the original's words. */
  sectionsToType: z.array(z.string()),
  template: z.string().nullable(),
  gate: gate.extend({ open: z.boolean() }).nullable(),
  createdBy: person.nullable(),
  original: output({ id: id(), language: z.string(), status }).nullable(),
  languages: z.array(
    output({ id: id(), language: z.string(), status, origin, translationStatus: z.enum(TRANSLATION_STATES).nullable(), translationCheckedBy: person.nullable(), marketCode: z.string().nullable(), sectionsToType: z.array(z.string()), original: z.boolean() }),
  ),
  /** A generated draft against today's records: the sections that differ (typed ones never), whether the lists changed, what would refuse a refresh. */
  stale: output({
    differences: z.array(output({ key: z.string(), stored: z.string().nullable(), fresh: z.string().nullable() })),
    lists: output({ positions: z.boolean(), spares: z.boolean() }),
    problems: z.array(problem),
  }).nullable(),
  problems: z.array(problem),
  packs: z.array(languagePack),
  batches: z.array(timelineGroup),
  /** Where the leaflet sends the reader for the DoC (Annex II 1.4(l)). */
  publication: output({ docAddress: z.string() }).nullable(),
  may: output({ edit: z.boolean(), refresh: z.boolean(), translate: z.boolean(), check: z.boolean(), withdraw: z.boolean() }),
})

const documentParams = input({ documentId: id() })
const detailAnswer = output({ leaflet: leafletDetail })

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
        sections: z.array(section),
        protectorPositions: z.array(protectorPosition),
        spareProtectors: z.array(spareProtector),
        blocking: z.array(problem),
        warnings: z.array(problem),
        missingPhrases: z.array(z.string()),
        existing: output({ id: id(), status: z.string() }).nullable(),
      }),
    }),
  },
})

export const createContract = defineContract({
  body: input({
    styleId: id(),
    revisionId: id().optional(),
    /** For a style of every company: the company whose leaflet it is (the maker, for our styles). */
    companyId: id().optional(),
    /** The original's language first, then its translations'. */
    languages: z.array(language()).min(1).max(10),
    /** The market the original is made for (its operators: the importer). */
    marketCode: marketCode().nullable().optional(),
    /** Markets whose language packs to start with it (a translation per language they ask). */
    packs: z.array(marketCode()).max(20).optional(),
  }),
  response: { 201: detailAnswer },
})

export const packsContract = defineContract({
  querystring: input({ styleId: id(), revisionId: id().optional() }),
  response: {
    200: output({
      style: output({ id: id(), code: z.string(), name: z.string() }),
      revision: output({ id: id(), revision: z.number().int(), status: z.string() }),
      original: output({ id: id(), language: z.string(), status: z.string() }).nullable(),
      packs: z.array(languagePack),
      asOf: instant(),
      gate,
    }),
  },
})

export const batchesContract = defineContract({
  querystring: input({ workOrderId: id().optional(), styleId: id().optional(), batchNumber: z.string().trim().min(1).max(60).optional() }),
  response: {
    200: output({
      batch: output({
        batchNumber: z.string().nullable(),
        style: output({ id: id(), code: z.string() }),
        workOrder: output({ id: id(), number: z.string(), revision: z.number().int().nullable() }).nullable(),
        released: z.boolean(),
      }),
      leaflets: z.array(
        output({
          language: z.string(),
          documentId: id(),
          number: z.string().nullable(),
          revision: z.number().int(),
          status: z.string(),
          recorded: output({ shipments: z.array(output({ id: id(), number: z.string() })) }).nullable(),
        }),
      ),
      drafts: z.array(output({ language: z.string(), documentId: id(), status: z.string(), translationStatus: z.string().nullable() })),
      gate,
    }),
  },
})

export const getContract = defineContract({ params: documentParams, response: { 200: detailAnswer } })
/** A generated draft's PDF, painted now (application/pdf, inline). */
export const pdfContract = defineContract({ params: documentParams, response: {} })

const sectionEdit = input({ key: z.enum(SECTION_KEYS), text: z.string().min(1).max(WORDS_MAX) })

export const editContract = defineContract({
  params: documentParams,
  body: input({
    version: version(),
    sections: z.array(sectionEdit).max(SECTION_KEYS.length).optional(),
    number: z.string().trim().min(1).max(60).nullable().optional(),
    marketCode: marketCode().nullable().optional(),
  }),
  response: { 200: detailAnswer },
})

export const refreshContract = defineContract({ params: documentParams, body: input({ version: version(), keepTyped: z.boolean().optional() }), response: { 200: detailAnswer } })
export const withdrawContract = defineContract({ params: documentParams, body: input({ version: version(), reason: z.string().min(1).max(500) }), response: { 200: detailAnswer } })
export const translationsContract = defineContract({
  params: documentParams,
  body: input({ languages: z.array(language()).max(10).optional(), packs: z.array(marketCode()).max(20).optional() }),
  response: { 201: detailAnswer },
})
export const translationStateContract = defineContract({ params: documentParams, body: input({ version: version(), state: z.enum(['DRAFT', 'IN_TRANSLATION']) }), response: { 200: detailAnswer } })
export const checkContract = defineContract({ params: documentParams, body: input({ version: version() }), response: { 200: detailAnswer } })

