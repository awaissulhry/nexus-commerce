import type { Issue } from '../../core/errors'
import type { ReleaseCheckCode, ReleaseChecklist } from '../work-orders/release'

/**
 * "Print and start the work" runs today's release checks first (owb- order workflow, S3 ss2 step 2.1; settle L1, plan.md § 5 A + H,
 * the Owner's yes 2026-11-28). Every work order of the order is checked; every problem is listed in words at once. Law, money,
 * structure and holds REFUSE (most are enforced by the database's work order guard too); only a material shortage and a credit
 * WARN let it go on (a shortage with a reason: today's materialOverride). Pure: apps/factory-api modules/production/print-start
 * reads each work order's checklist (today's checklistOf) and the credit and gate answers, and calls these.
 *
 *   STRUCTURE  REVISION, LABEL_TEMPLATE, WORK_CENTRES, BOM, CELLS, BATCH_NUMBER   the product or the set-up is not ready
 *   LAW        CERTIFICATE, the compliance gate                                   a law requirement (PPE certificate, a gate)
 *   MONEY      DEPOSIT, a credit HOLD                                             the deposit, the customer's credit
 *   HOLD       HOLDS                                                              a quality hold, a work order on hold (pick B)
 *   WARN       MATERIAL, a credit WARN                                            go on (MATERIAL with a reason)
 */

export const CHECK_CLASSES = ['STRUCTURE', 'LAW', 'MONEY', 'HOLD', 'WARN'] as const
export type CheckClass = (typeof CHECK_CLASSES)[number]

/** The print's own checks beside today's release checks: the compliance gate and the customer's credit. */
export const PRINT_EXTRA_CHECKS = ['COMPLIANCE_GATE', 'CREDIT_HOLD', 'CREDIT_WARN'] as const
export type PrintExtraCheck = (typeof PRINT_EXTRA_CHECKS)[number]
export type PrintCheckCode = ReleaseCheckCode | PrintExtraCheck

export const CHECK_CLASS: Readonly<Record<PrintCheckCode, CheckClass>> = Object.freeze({
  REVISION: 'STRUCTURE',
  LABEL_TEMPLATE: 'STRUCTURE',
  WORK_CENTRES: 'STRUCTURE',
  BOM: 'STRUCTURE',
  CELLS: 'STRUCTURE',
  BATCH_NUMBER: 'STRUCTURE',
  CERTIFICATE: 'LAW',
  COMPLIANCE_GATE: 'LAW',
  DEPOSIT: 'MONEY',
  CREDIT_HOLD: 'MONEY',
  HOLDS: 'HOLD',
  MATERIAL: 'WARN',
  CREDIT_WARN: 'WARN',
})

/** One problem as the preview lists it and the refusal answers it (the Shape of build/briefs/owb-ss2.md). */
export interface PrintProblem {
  readonly code: string
  readonly class: CheckClass
  /** The work order it is about (null: the order's, e.g. the customer's credit). */
  readonly workOrderNumber: string | null
  readonly words: string
}

/** One work order's checklist (today's checklistOf, with no override), by its number. */
export interface WorkOrderChecks {
  readonly workOrderNumber: string
  readonly checklist: ReleaseChecklist
}

/** An extra problem of the print (the credit, the compliance gate), already in words. */
export interface ExtraProblem {
  readonly code: PrintExtraCheck
  readonly workOrderNumber: string | null
  readonly words: string
}

export interface PrintCheckAnswer {
  readonly problems: readonly PrintProblem[]
  /** A problem that is not a warning: the print is refused (409 with the list). */
  readonly refused: boolean
  /** A material shortage: the person goes on only with a reason (today's materialOverride.reason). */
  readonly needsMaterialReason: boolean
}

const wordsOf = (issue: Issue): string => issue.message

/**
 * Every problem of every work order (each BLOCKED check's problems, in the checks' order) and of the print, classed; refused when
 * one is not a WARN; a material shortage asks for a reason.
 */
export function printProblems(checks: readonly WorkOrderChecks[], extras: readonly ExtraProblem[] = []): PrintCheckAnswer {
  const problems: PrintProblem[] = []
  for (const entry of checks) {
    for (const check of entry.checklist.checks) {
      if (check.state !== 'BLOCKED') continue
      for (const issue of check.problems) problems.push({ code: check.code, class: CHECK_CLASS[check.code], workOrderNumber: entry.workOrderNumber, words: wordsOf(issue) })
    }
  }
  for (const extra of extras) problems.push({ code: extra.code, class: CHECK_CLASS[extra.code], workOrderNumber: extra.workOrderNumber, words: extra.words })
  return {
    problems,
    refused: problems.some((problem) => problem.class !== 'WARN'),
    needsMaterialReason: problems.some((problem) => problem.code === 'MATERIAL'),
  }
}

/** The words the print answers with when it refuses (409), before the list. */
export const PRINT_REFUSED_WORDS = Object.freeze({
  en: 'The work cannot start yet: fix every problem below first (law, money and structure stop it; a material shortage goes on with a reason).',
  it: 'Il lavoro non può ancora partire: risolvi prima ogni problema qui sotto (legge, denaro e struttura lo fermano; una mancanza di materiale va avanti con un motivo).',
})

/** The words when a material shortage was not given its reason (409). */
export const MATERIAL_REASON_WORDS = Object.freeze({
  en: 'Material is short: say why the work starts anyway (the reason is kept on the release).',
  it: 'Manca del materiale: scrivi perché il lavoro parte comunque (il motivo resta sul rilascio).',
})
