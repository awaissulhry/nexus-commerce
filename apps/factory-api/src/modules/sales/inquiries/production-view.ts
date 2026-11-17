import { can } from '@nexus/factory-domain/core/permissions'
import { toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { PLANNING_PROMISE_MANAGE } from '@nexus/factory-domain/planning/promise/permissions'
import { daysAfterWanted, PRODUCTION_REFUSAL_WORDS, productionTone, productionWords, weekOf, type ProductionAnswer } from '@nexus/factory-domain/sales/inquiries/production-answer'
import { editRefusal } from '@nexus/factory-domain/sales/inquiries/rules'
import { actorOf, type OfficeContext } from '../../../core/context'
import { dayOrNull, factsOf, scopeOf, type InquiryData, type Reader } from './store'

/**
 * B-TH-094 (N17; O-SAL-INQ-LIST.list-F10, .pane-head-F07): production's answer as a request's row, record and Incoming row show
 * it (./views.ts), and who may type it (./production-answer.ts). Apart from the routes' file so the views read it without an
 * import cycle (inquiries.ts → views.ts → here). Office only: a portal read never comes here.
 */

/** Whether the person types production's answer on this request (planning.promise.manage over its company and customer). */
export const mayAnswer = (context: OfficeContext, row: Pick<InquiryData, 'companyId' | 'partyId'>): boolean => can(actorOf(context), PLANNING_PROMISE_MANAGE, scopeOf(row))

type AnswerColumns = Pick<InquiryData, 'wantedDate' | 'productionAnswer' | 'productionNotBefore' | 'productionAnsweredAt'>

/** The answer as a row shows it (null: not answered). Names nobody: the record adds who answered. */
export function productionOf(row: AnswerColumns, today: BusinessDate) {
  if (row.productionAnswer === null || row.productionAnsweredAt === null) return null
  const answer = row.productionAnswer as ProductionAnswer
  const notBefore = dayOrNull(row.productionNotBefore)
  const week = notBefore ? weekOf(notBefore) : null
  return {
    answer,
    notBefore,
    week: week?.key ?? null,
    weekNumber: week?.week ?? null,
    words: productionWords(answer, notBefore, today),
    tone: productionTone(answer),
    daysAfterWanted: daysAfterWanted(notBefore, dayOrNull(row.wantedDate)),
    answeredAt: toUtcIso(row.productionAnsweredAt),
  }
}

/** The answer as the record shows it: with who answered, by name (an office person). */
export async function productionInRecord(db: Reader, row: AnswerColumns & Pick<InquiryData, 'productionAnsweredById'>, today: BusinessDate) {
  const view = productionOf(row, today)
  if (!view) return null
  const person = row.productionAnsweredById ? await db.user.findFirst({ where: { id: row.productionAnsweredById, audience: 'OFFICE' }, select: { id: true, displayName: true } }) : null
  return { ...view, answeredBy: person ? { id: person.id, name: person.displayName } : null }
}

/** The record's "Production answer" action for this reader: allowed, or held with why. */
export function productionActionOf(context: OfficeContext, row: InquiryData) {
  if (!mayAnswer(context, row)) return { allowed: false, refusal: { code: 'NOT_PRODUCTION', message: PRODUCTION_REFUSAL_WORDS.NOT_PRODUCTION.en, words: PRODUCTION_REFUSAL_WORDS.NOT_PRODUCTION } }
  const closed = editRefusal(factsOf(row))
  return closed ? { allowed: false, refusal: { code: closed.code, message: closed.message } } : { allowed: true, refusal: null }
}
