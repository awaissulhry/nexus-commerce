import type { Issue } from '../../core/errors'
import { DEFECT_CODE, wordsProblems, type WordsDraft } from './rules'

/**
 * Cause and responsible-process codes (B-W2b-90; QHS-004; design quality.defects df-causes "Material, supplier, cutting,
 * sewing, finishing, handling, design, measurement"; factory-db holds.prisma CauseCode, B-W2b-79), pure. Why a defect
 * happened and which process answers for it: an inspection defect and an NCR name one (and the CAPA after them). One list
 * for the whole group (tenant-wide, as the defect library); apps/factory-api's modules/quality/defects/causes.ts says these
 * rules in words before the database's CauseCode_guard would refuse the same:
 *
 *   - a code is upper-case letters, digits, hyphens and underscores (2-40, no spaces), unique in the tenant, and never
 *     changes; nor does its process (reports group by it): retire the code and add another;
 *   - Italian and English words, the other floor languages by ISO 639 code (as the defect library's);
 *   - a code in use is retired (inactive: it leaves the pickers and stays on what names it); one nothing names may be deleted;
 *   - a new tenant starts from the starter set: one code per process (the seed's shape, factory-db seed/capa.ts).
 */

/** factory-db CauseProcess, in its order (a PG test compares them). */
export const CAUSE_PROCESSES = ['MATERIAL', 'SUPPLIER', 'CUTTING', 'SEWING', 'FINISHING', 'HANDLING', 'DESIGN', 'MEASUREMENT'] as const
export type CauseProcess = (typeof CAUSE_PROCESSES)[number]

/** The process in words (the grid's process column, the picker's second line). */
export const PROCESS_WORDS: Readonly<Record<CauseProcess, { readonly it: string; readonly en: string }>> = Object.freeze({
  MATERIAL: { it: 'Materiale', en: 'Material' },
  SUPPLIER: { it: 'Fornitore', en: 'Supplier' },
  CUTTING: { it: 'Taglio', en: 'Cutting' },
  SEWING: { it: 'Cucitura', en: 'Sewing' },
  FINISHING: { it: 'Finitura', en: 'Finishing' },
  HANDLING: { it: 'Movimentazione', en: 'Handling' },
  DESIGN: { it: 'Progettazione', en: 'Design' },
  MEASUREMENT: { it: 'Misura', en: 'Measurement' },
})

export const isCauseProcess = (value: string): value is CauseProcess => (CAUSE_PROCESSES as readonly string[]).includes(value)

/** A cause code: as a defect's (no spaces; the guard's rule). */
export const CAUSE_CODE = DEFECT_CODE

export const CAUSE_LIMITS = Object.freeze({ perTenant: 200 })

export interface CauseDraft extends Omit<WordsDraft, 'icon' | 'colour'> {
  readonly code?: string | undefined
  readonly process?: string | undefined
  readonly sortOrder?: number | undefined
}

/** A new code (`creating`) or a change of one: a change never names the code or the process. */
export function causeDraftProblems(draft: CauseDraft, creating: boolean): Issue[] {
  const problems: Issue[] = []
  if (creating) {
    if (draft.code === undefined || !CAUSE_CODE.test(draft.code)) problems.push({ path: 'code', message: 'A code is 2 to 40 upper-case letters, digits, hyphens and underscores, starting with a letter (SEW-ERROR).' })
    if (draft.process === undefined || !isCauseProcess(draft.process)) problems.push({ path: 'process', message: 'Say which process answers for it: material, supplier, cutting, sewing, finishing, handling, design or measurement.' })
  } else {
    for (const field of ['code', 'process'] as const) {
      if (draft[field] !== undefined) problems.push({ path: field, message: 'The code and its process never change (records and reports keep them): retire it and add another.' })
    }
  }
  problems.push(...wordsProblems(draft, 'cause'))
  if (creating) {
    if (draft.labelIt === undefined) problems.push({ path: 'labelIt', message: 'Name the cause in Italian.' })
    if (draft.labelEn === undefined) problems.push({ path: 'labelEn', message: 'Name the cause in English.' })
  }
  if (draft.sortOrder !== undefined && (!Number.isInteger(draft.sortOrder) || draft.sortOrder < 0 || draft.sortOrder > 1_000_000)) problems.push({ path: 'sortOrder', message: 'A whole number from 0.' })
  return problems
}

export interface StarterCause {
  readonly code: string
  readonly process: CauseProcess
  readonly labelIt: string
  readonly labelEn: string
}

const c = (code: string, process: CauseProcess, labelIt: string, labelEn: string): StarterCause => Object.freeze({ code, process, labelIt, labelEn })

/** One code per process, in the processes' order (the seed's codes, so a seeded tenant misses none). Made-up wording. */
export const STARTER_CAUSES: readonly StarterCause[] = Object.freeze([
  c('MAT-FAULT', 'MATERIAL', 'Difetto del materiale', 'Material fault'),
  c('SUP-SPEC', 'SUPPLIER', 'Fornitore fuori specifica', 'Supplier out of specification'),
  c('CUT-ERROR', 'CUTTING', 'Errore di taglio', 'Cutting error'),
  c('SEW-ERROR', 'SEWING', 'Errore di cucitura', 'Sewing error'),
  c('FIN-ERROR', 'FINISHING', 'Errore di finitura', 'Finishing error'),
  c('HANDLING', 'HANDLING', 'Danno da movimentazione', 'Handling damage'),
  c('DESIGN', 'DESIGN', 'Errore di progetto', 'Design error'),
  c('MEASURE', 'MEASUREMENT', 'Errore di misura', 'Measurement error'),
])

/** The starter codes a tenant does not have yet (by code), in the starter set's order. */
export const missingCauses = (existing: ReadonlySet<string>): StarterCause[] => STARTER_CAUSES.filter((cause) => !existing.has(cause.code))
