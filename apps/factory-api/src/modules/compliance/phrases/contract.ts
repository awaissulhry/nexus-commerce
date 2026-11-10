import { z } from 'zod'
import { CELL_STATES, LANGUAGE_TAG_MAX, NOTE_MAX, PHRASE_KINDS, TRANSLATION_STATUSES, WORDS_MAX } from '@nexus/factory-domain/compliance/phrases/rules'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'

/**
 * The phrase library (B-W2b-249; PRD-343; design compliance.settings › rm-phrases, compliance.labels › Languages): keys,
 * kinds, source words, one cell per language (approved / proposed / stale / missing) and the history of a phrase's
 * translations. People by name only where they proposed or approved a translation.
 */

const version = () => z.number().int().min(1)
const person = output({ id: id(), name: z.string() }).nullable()

export const phraseView = output({
  id: id(),
  key: z.string(),
  kind: z.enum(PHRASE_KINDS),
  companyId: id().nullable(),
  sourceLanguage: z.string(),
  sourceText: z.string(),
  /** Up by one with every new source words: a translation of an older revision is stale. */
  revision: z.number().int(),
  note: z.string().nullable(),
  status: z.enum(['ACTIVE', 'ARCHIVED']),
  version: z.number().int(),
  updatedAt: instant(),
  cells: z.array(
    output({
      language: z.string(),
      state: z.enum(CELL_STATES),
      approved: output({ id: id(), text: z.string(), revision: z.number().int(), sourceRevision: z.number().int(), approvedAt: instant().nullable(), approvedBy: person }).nullable(),
      draft: output({ id: id(), text: z.string(), revision: z.number().int(), sourceRevision: z.number().int(), proposedBy: person, version: z.number().int() }).nullable(),
    }),
  ),
})
export type PhraseView = z.infer<typeof phraseView>

const languageList = z
  .string()
  .trim()
  .max(400)
  .transform((value) => [...new Set(value.split(',').map((entry) => entry.trim()).filter((entry) => entry !== ''))])
  .pipe(z.array(z.string().min(2).max(LANGUAGE_TAG_MAX)).max(30))

export const listPhrasesContract = defineContract({
  querystring: input({
    kind: z.enum(PHRASE_KINDS).optional(),
    status: z.enum(['ACTIVE', 'ARCHIVED', 'ALL']).optional(),
    q: z.string().trim().min(1).max(100).optional(),
    /** The language columns (comma separated); default: every language a switched-on market needs. */
    languages: languageList.optional(),
  }),
  response: { 200: output({ phrases: z.array(phraseView), languages: z.array(z.string()), asOf: instant(), mayManage: z.boolean(), mayApprove: z.boolean() }) },
})

const phraseParams = input({ key: z.string().trim().min(1).max(100) })

export const getPhraseContract = defineContract({
  params: phraseParams,
  response: {
    200: output({
      phrase: phraseView,
      history: z.array(
        output({
          id: id(),
          language: z.string(),
          revision: z.number().int(),
          text: z.string(),
          status: z.enum(TRANSLATION_STATUSES),
          sourceRevision: z.number().int(),
          proposedBy: person,
          proposedAt: instant(),
          approvedBy: person,
          approvedAt: instant().nullable(),
        }),
      ),
    }),
  },
})

export const textsContract = defineContract({
  querystring: input({
    keys: z
      .string()
      .trim()
      .min(1)
      .max(4000)
      .transform((value) => [...new Set(value.split(',').map((entry) => entry.trim()).filter((entry) => entry !== ''))])
      .pipe(z.array(z.string().min(1).max(100)).min(1).max(100)),
    languages: languageList,
  }),
  response: { 200: output({ texts: z.array(output({ key: z.string(), language: z.string(), text: z.string().nullable(), revision: z.number().int() })) }) },
})

export const createPhraseContract = defineContract({
  body: input({
    key: z.string().trim().min(1).max(100),
    kind: z.enum(PHRASE_KINDS),
    /** ISO 639; Italian by default. */
    sourceLanguage: z.string().trim().min(2).max(3).optional(),
    sourceText: z.string().trim().min(1).max(WORDS_MAX),
    note: z.string().trim().min(1).max(NOTE_MAX).nullable().optional(),
    /** Leave it out for a phrase of every company. */
    companyId: id().nullable().optional(),
  }),
  response: { 200: output({ phrase: phraseView }) },
})

export const editPhraseContract = defineContract({
  params: phraseParams,
  body: input({
    version: version(),
    kind: z.enum(PHRASE_KINDS).optional(),
    /** New source words (or language): the next revision; every approved translation is stale until translated again. */
    sourceText: z.string().trim().min(1).max(WORDS_MAX).optional(),
    sourceLanguage: z.string().trim().min(2).max(3).optional(),
    note: z.string().trim().min(1).max(NOTE_MAX).nullable().optional(),
    status: z.enum(['ACTIVE', 'ARCHIVED']).optional(),
  }),
  response: { 200: output({ phrase: phraseView }) },
})

export const proposeContract = defineContract({
  params: phraseParams,
  body: input({
    language: z.string().trim().min(2).max(LANGUAGE_TAG_MAX),
    text: z.string().trim().min(1).max(WORDS_MAX),
    /** The draft's version when it replaces the words of the language's waiting draft. */
    version: version().optional(),
  }),
  response: { 200: output({ phrase: phraseView }) },
})

const translationParams = input({ key: z.string().trim().min(1).max(100), translationId: id() })

export const approveContract = defineContract({ params: translationParams, body: input({ version: version() }), response: { 200: output({ phrase: phraseView }) } })

export const withdrawContract = defineContract({
  params: translationParams,
  querystring: input({ version: z.coerce.number().int().min(1) }),
  response: { 200: output({ phrase: phraseView }) },
})
