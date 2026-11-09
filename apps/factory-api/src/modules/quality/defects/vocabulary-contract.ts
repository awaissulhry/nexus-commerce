import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { CAUSE_PROCESSES } from '@nexus/factory-domain/quality/defects/causes'
import { DEFECT_CLASSES, DEFECT_LIMITS, QUALITY_STAGES } from '@nexus/factory-domain/quality/defects/rules'

/**
 * The defect vocabulary of B-W2b-90 (QHS-002 severity, QHS-004 causes, QHS-006 grades and hide defects, QHS-007 the
 * picker in the person's language): the contracts of severity.ts, causes.ts, grades.ts and vocabulary.ts. Words are
 * checked in factory-domain quality/defects (answers in words at `body/<field>`); the lengths here only stop oversized
 * bodies. No money anywhere; a usable share is a percent as text ("72.50").
 */

const version = z.number().int().min(1)
const words = () => z.string().max(DEFECT_LIMITS.label * 2)
const labels = () => z.record(z.string().max(8), words().nullable())
const klass = z.enum(DEFECT_CLASSES)
const stage = z.enum(QUALITY_STAGES)
const process = z.enum(CAUSE_PROCESSES)
const itEn = () => output({ it: z.string(), en: z.string() })
const activeQuery = input({ active: z.enum(['true', 'false']).optional() })

// ---- severity (QHS-002) ---------------------------------------------------------------------------------------------

const textsByLanguage = () => z.record(z.string().max(8), z.string())
const severityAnswer = output({
  classes: z.array(
    output({
      class: klass,
      /** 0 = worst. */
      rank: z.number().int(),
      /** In force: the tenant's words, else the standard ones (B-W2b-213). */
      words: itEn(),
      meaning: itEn(),
      /** The acceptance number every plan gives the class (critical: 0); null: the plan's AQL decides. */
      acceptanceNumber: z.number().int().nullable(),
      locked: z.boolean(),
      law: z.string().nullable(),
      /** Active defects of the library with this default class. */
      defects: z.number().int().min(0),
      /** B-W2b-213: what the tenant wrote per language (none: the standard text), and the standard texts. */
      own: output({ words: textsByLanguage(), meaning: textsByLanguage() }),
      standard: output({ words: itEn(), meaning: itEn() }),
    }),
  ),
  safetyRule: output({ it: z.string(), en: z.string(), law: z.string() }),
  /** True since B-W2b-213 (QualitySettings.severityTexts): the words are the tenant's to write; critical's meaning stays locked. */
  editable: z.boolean(),
  /** Italian, English and the sites' other floor languages: the editor's columns. */
  languages: z.array(z.string()),
  canManage: z.boolean(),
  /** The tenant-wide settings row's version (0: none yet): PUT sends it back. */
  version: z.number().int().min(0),
  updatedAt: instant().nullable(),
})

export const severityContract = defineContract({ response: { 200: severityAnswer } })

/** B-W2b-213: the whole set of the tenant's words (a class, part or language left out: the standard text), or null. */
export const saveSeverityContract = defineContract({
  body: input({
    version: z.number().int().min(0),
    texts: z.record(z.string().max(12), z.record(z.string().max(12), z.record(z.string().max(8), z.string().max(1000)))).nullable(),
  }),
  response: { 200: severityAnswer },
})

// ---- cause codes (QHS-004) ------------------------------------------------------------------------------------------

export const causeView = output({
  id: id(),
  code: z.string(),
  labelIt: z.string(),
  labelEn: z.string(),
  labelI18n: z.record(z.string(), z.string()),
  process,
  processWords: itEn(),
  sortOrder: z.number().int(),
  active: z.boolean(),
  /** How many inspection defects and NCRs name it. A used code is retired, never deleted. */
  usedCount: z.number().int().min(0),
  /** The tenant's other floor languages it has no words in. */
  missingLanguages: z.array(z.string()),
  version: z.number().int(),
  createdAt: instant(),
  updatedAt: instant(),
})
export type CauseView = z.infer<typeof causeView>

export const causesContract = defineContract({
  querystring: activeQuery,
  response: {
    200: output({
      causes: z.array(causeView),
      processes: z.array(output({ process, it: z.string(), en: z.string() })),
      /** The tenant's other floor languages (its sites' floorLocales but Italian and English): the word columns. */
      languages: z.array(z.string()),
      starterMissing: z.array(z.string()),
      canManage: z.boolean(),
    }),
  },
})

export const createCauseContract = defineContract({
  body: input({ code: z.string().max(80), process, labelIt: words(), labelEn: words(), labelI18n: labels().optional(), sortOrder: z.number().int().optional() }),
  response: { 201: output({ cause: causeView }) },
})

export const editCauseContract = defineContract({
  params: input({ causeId: id() }),
  body: input({ version, labelIt: words().optional(), labelEn: words().optional(), labelI18n: labels().optional(), sortOrder: z.number().int().optional(), active: z.boolean().optional() }),
  response: { 200: output({ cause: causeView, retireWords: z.string().nullable() }) },
})

export const deleteCauseContract = defineContract({
  params: input({ causeId: id() }),
  querystring: input({ version: z.coerce.number().int().min(1) }),
  response: { 200: output({ deleted: id(), code: z.string() }) },
})

export const starterCausesContract = defineContract({
  body: input({}),
  response: { 200: output({ added: z.array(z.string()) }) },
})

// ---- leather grades and hide defects (QHS-006) ----------------------------------------------------------------------

export const gradeView = output({
  id: id(),
  code: z.string(),
  labelIt: z.string(),
  labelEn: z.string(),
  labelI18n: z.record(z.string(), z.string()),
  /** Percent of a hide of this grade that can be cut ("72.00"): the default of an article without a rule of its own. */
  usableShare: z.string(),
  sortOrder: z.number().int(),
  active: z.boolean(),
  /** How many hides, grade rules, hide marks, remnants and incoming hide results name it. A grade is retired, never deleted. */
  usedCount: z.number().int().min(0),
  missingLanguages: z.array(z.string()),
  version: z.number().int(),
  createdAt: instant(),
  updatedAt: instant(),
})
export type GradeView = z.infer<typeof gradeView>

export const gradesContract = defineContract({
  querystring: activeQuery,
  response: {
    200: output({
      grades: z.array(gradeView),
      /** The library's hide category (LEATHER); null: the library has none yet (the defects' starter set adds it). */
      hideCategory: output({ id: id(), code: z.string(), labelIt: z.string(), labelEn: z.string(), icon: z.string().nullable(), colour: z.string().nullable(), active: z.boolean() }).nullable(),
      /** Its defects that apply at incoming or cutting; kept with PATCH /quality/defects/:defectId. */
      hideDefects: z.array(
        output({
          id: id(),
          code: z.string(),
          labelIt: z.string(),
          labelEn: z.string(),
          labelI18n: z.record(z.string(), z.string()),
          /** Its own icon and colour, else its category's. */
          icon: z.string().nullable(),
          colour: z.string().nullable(),
          pictureFileId: id().nullable(),
          severity: klass,
          stages: z.array(stage),
          active: z.boolean(),
          missingLanguages: z.array(z.string()),
          version: z.number().int(),
        }),
      ),
      hideStages: z.array(stage),
      languages: z.array(z.string()),
      starterMissing: z.array(z.string()),
      canManage: z.boolean(),
    }),
  },
})

export const createGradeContract = defineContract({
  body: input({ code: z.string().max(20), labelIt: words(), labelEn: words(), labelI18n: labels().optional(), usableShare: z.string().max(10), sortOrder: z.number().int().optional() }),
  response: { 201: output({ grade: gradeView }) },
})

export const editGradeContract = defineContract({
  params: input({ gradeId: id() }),
  body: input({ version, labelIt: words().optional(), labelEn: words().optional(), labelI18n: labels().optional(), usableShare: z.string().max(10).optional(), sortOrder: z.number().int().optional(), active: z.boolean().optional() }),
  response: { 200: output({ grade: gradeView, retireWords: z.string().nullable() }) },
})

export const starterGradesContract = defineContract({
  body: input({}),
  response: { 200: output({ added: z.array(z.string()) }) },
})

// ---- the vocabulary in the person's language (QHS-007) --------------------------------------------------------------

const pickedDefect = output({
  id: id(),
  code: z.string(),
  category: output({ id: id(), code: z.string(), label: z.string() }),
  /** The words in `language`; `missing`: it has none, its English words stand in. */
  label: z.string(),
  missing: z.boolean(),
  /** Its own icon and colour, else its category's (the tile). */
  icon: z.string().nullable(),
  colour: z.string().nullable(),
  pictureFileId: id().nullable(),
  /** The default class. */
  severity: klass,
  /** A critical defect stays critical on a record (the safety rule). */
  classLocked: z.boolean(),
  /** The classes a record may give it, worst first. */
  classes: z.array(klass),
  zone: z.string().nullable(),
  stages: z.array(stage),
  needsDetail: z.boolean(),
})

export const vocabularyContract = defineContract({
  querystring: input({ stage: stage.optional(), language: z.string().max(8).optional() }),
  response: {
    200: output({
      /** The language of the words below. */
      language: z.string(),
      /** Italian, English and the other floor languages of the sites the session sees. */
      languages: z.array(z.string()),
      classes: z.array(output({ class: klass, label: z.string(), meaning: z.string(), locked: z.boolean(), missing: z.boolean() })),
      defects: z.array(pickedDefect),
      /** The hide vocabulary of incoming and cutting: the hide category's defects that apply there. */
      hideDefects: z.array(pickedDefect),
      causes: z.array(output({ id: id(), code: z.string(), label: z.string(), missing: z.boolean(), process, processLabel: z.string() })),
      grades: z.array(output({ id: id(), code: z.string(), label: z.string(), missing: z.boolean(), usableShare: z.string() })),
    }),
  },
})

export const coverageContract = defineContract({
  response: {
    200: output({
      languages: z.array(
        output({
          language: z.string(),
          sites: z.number().int().min(0),
          /** The active codes of each list (COVERAGE_LISTS) with no words in the language. */
          missing: output({ DEFECTS: z.array(z.string()), CAUSES: z.array(z.string()), GRADES: z.array(z.string()) }),
          complete: z.boolean(),
        }),
      ),
    }),
  },
})
