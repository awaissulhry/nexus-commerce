import { DomainError, ForbiddenError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { businessDate } from '@nexus/factory-domain/core/time'
import { eventFor } from '@nexus/factory-domain/events/define'
import { PLANNING_PROMISE_VIEW } from '@nexus/factory-domain/planning/promise/permissions'
import { events as inquiryEvents } from '@nexus/factory-domain/sales-inquiries/events'
import { SALES_INQUIRIES_VIEW } from '@nexus/factory-domain/sales/inquiries/permissions'
import { checkedProductionAnswer, LEFT_OUT_WORDS, PRODUCTION_REFUSAL_WORDS, sizesOutsideWords, suggestedAnswer, weekOf, type ProductionAnswerBody, type Words } from '@nexus/factory-domain/sales/inquiries/production-answer'
import { editRefusal, sizesOf } from '@nexus/factory-domain/sales/inquiries/rules'
import { command, StaleVersionError, type CommandCaller, type CommandTools } from '../../../core/command'
import type { OfficeContext } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { answerPromises, type AskAnswer, type PromiseAsk } from '../../planning/promise/engine'
import { whereOf } from '../../planning/promise/read'
import { mayPromiseAt, plantOf } from '../../planning/promise/store'
import { viewInCommand, writeInquiry } from './inquiries'
import { asDay, databaseRefusal, dayOrNull, factsOf, LINE_COLUMNS, may, officeInquiry, readInquiryRow, refuse, type InquiryData } from './store'
import { mayAnswer, productionInRecord } from './production-view'

/**
 * B-TH-094 (threads plan TH-9, N17, X-G04; features O-SAL-INQ-LIST.list-F10, .pane-head-F07): production's answer on a request,
 * "OK" or "not before week N", typed by the production manager, offered from planning's promise read (rules: factory-domain
 * sales/inquiries/production-answer). Office only.
 *
 *   PUT /sales/inquiries/:inquiryId/production-answer              {version, answer: OK | NOT_BEFORE | null, week?: 2026-W14}:
 *                                                                  the answer (NOT_BEFORE with this week or a later one), or
 *                                                                  taken back (null); the newest is kept, the history is the
 *                                                                  request's Changes (the audit rows)
 *   GET /sales/inquiries/:inquiryId/production-answer/suggestion   ?siteId: what planning's promise read (ATP / capable to
 *                                                                  promise, modules/planning/promise) suggests for the request's
 *                                                                  lines that name a style, a colourway and sizes; nothing is
 *                                                                  written, the person types the answer
 *
 * Who: the request is read with sales.inquiries.view over its company and customer (else 404: a person limited to brand A never
 * finds brand B's request); typing the answer is planning.promise.manage over the same scope (planning owns promise dates,
 * PLN-171: the planner and the production manager hold it, sales does not), the suggestion planning.promise.view at the site.
 * The customer never reads it: the partner role cannot read the four columns (factory-db ownership/sales-intake.json), the
 * portal's request reads name only partner columns, and the event is its own (inquiry.production_answered, office live only),
 * never the inquiry.changed a portal session also receives. A closed request keeps the answer it had (409 refusal/CLOSED, and
 * the sales intake guard). No money, nobody counted.
 */

const answered = inquiryEvents.find((event) => event.type === 'inquiry.production_answered')!

/** The 409 of taking back an answer production never gave. */
const noAnswer = () => new DomainError('conflict', PRODUCTION_REFUSAL_WORDS.NO_ANSWER.en, [{ path: 'refusal/NO_ANSWER', message: PRODUCTION_REFUSAL_WORDS.NO_ANSWER.en }])

/** The request locked at the version read: seen by the caller (else 404), its answer the caller's to type (else 403). */
async function lockForAnswer(tools: CommandTools, context: OfficeContext, inquiryId: string, version: number): Promise<InquiryData> {
  if (!isUuid(inquiryId)) throw new NotFoundError('Inquiry not found.')
  await tools.tx.$queryRaw`SELECT id FROM "Inquiry" WHERE id = ${inquiryId}::uuid FOR UPDATE`
  const row = await readInquiryRow(tools.tx, inquiryId)
  if (!row || !may(context, SALES_INQUIRIES_VIEW, row)) throw new NotFoundError('Inquiry not found.')
  if (!mayAnswer(context, row)) throw new ForbiddenError(PRODUCTION_REFUSAL_WORDS.NOT_PRODUCTION.en)
  if (row.version !== version) throw new StaleVersionError('Inquiry', inquiryId, row.version, version)
  return row
}

/** PUT /sales/inquiries/:inquiryId/production-answer */
export async function setProductionAnswer(caller: CommandCaller, inquiryId: string, body: ProductionAnswerBody, idempotencyKey?: string) {
  const { context, inquiry } = await officeInquiry(caller, inquiryId)
  if (!mayAnswer(context, inquiry)) throw new ForbiddenError(PRODUCTION_REFUSAL_WORDS.NOT_PRODUCTION.en)
  refuse(editRefusal(factsOf(inquiry)))
  const checked = checkedProductionAnswer({ answer: body.answer, week: body.week }, businessDate(serverClock.now()))
  if (!checked.ok) throw new ValidationError(checked.words.en, [{ path: checked.path, message: checked.words.en }])
  if (checked.answer === null && inquiry.productionAnswer === null) throw noAnswer()
  const { result } = await command(caller, { name: 'sales.inquiries.productionAnswer', idempotencyKey, input: { inquiryId, ...body } }, async (tools) => {
    const row = await lockForAnswer(tools, context, inquiryId, body.version)
    refuse(editRefusal(factsOf(row)))
    if (checked.answer === null && row.productionAnswer === null) throw noAnswer()
    const before = { productionAnswer: row.productionAnswer, productionNotBefore: dayOrNull(row.productionNotBefore) }
    if (checked.answer === null) {
      await writeInquiry(tools, row, { productionAnswer: null, productionNotBefore: null, productionAnsweredAt: null, productionAnsweredById: null })
    } else {
      await writeInquiry(tools, row, { productionAnswer: checked.answer, productionNotBefore: checked.notBefore ? asDay(checked.notBefore) : null, productionAnsweredAt: tools.now, productionAnsweredById: context.actorId })
    }
    tools.audit({
      action: checked.answer === null ? 'sales.inquiries.productionAnswerTakenBack' : 'sales.inquiries.productionAnswer',
      recordType: 'Inquiry',
      recordId: row.id,
      companyId: row.companyId,
      before,
      after: { productionAnswer: checked.answer, productionNotBefore: checked.notBefore },
    })
    tools.emit(eventFor(answered, { subject: row.id, companyId: row.companyId, payload: { inquiryId: row.id, number: row.number, answer: checked.answer, notBefore: checked.notBefore, partyId: row.partyId } }))
    return { inquiry: await viewInCommand(tools, row.id) }
  }).catch(databaseRefusal)
  return result
}

// ---- the suggestion ---------------------------------------------------------------------------------------------------------

const ids = (values: readonly (string | null)[]): string[] => [...new Set(values.filter((value): value is string => value !== null))]

/** GET /sales/inquiries/:inquiryId/production-answer/suggestion */
export async function productionSuggestion(caller: CommandCaller, inquiryId: string, query: { readonly siteId?: string | undefined }) {
  const { context, inquiry } = await officeInquiry(caller, inquiryId)
  return caller.withClient(async (db) => {
    const site = await plantOf(db, inquiry.companyId, query.siteId, 'querystring/siteId')
    if (!mayPromiseAt(context, PLANNING_PROMISE_VIEW, site)) throw new ForbiddenError('Your role does not read promise dates at this site.')
    const now = serverClock.now()
    const lines = await db.inquiryLine.findMany({ where: { inquiryId: inquiry.id }, select: LINE_COLUMNS, orderBy: { seq: 'asc' } })
    const styles = new Map((await db.style.findMany({ where: { id: { in: ids(lines.map((line) => line.styleId)) } }, select: { id: true, sizes: true } })).map((style) => [style.id, style]))
    const colourways = new Map((await db.colourway.findMany({ where: { id: { in: ids(lines.map((line) => line.colourwayId)) } }, select: { id: true, styleId: true } })).map((colourway) => [colourway.id, colourway]))
    const wanted = dayOrNull(inquiry.wantedDate)
    const asks: PromiseAsk[] = []
    const leftOut: { lineId: string; seq: number; why: Words }[] = []
    for (const line of lines) {
      const style = line.styleId ? styles.get(line.styleId) : undefined
      const colourway = line.colourwayId ? colourways.get(line.colourwayId) : undefined
      const sizes = Object.entries(sizesOf(line.sizes)).filter(([, quantity]) => quantity > 0)
      const outside = style ? sizes.map(([size]) => size).filter((size) => !style.sizes.includes(size)) : []
      const why = !line.styleId
        ? LEFT_OUT_WORDS.NO_STYLE
        : !style
          ? LEFT_OUT_WORDS.STYLE_UNKNOWN
          : !colourway || colourway.styleId !== style.id
            ? LEFT_OUT_WORDS.NO_COLOUR
            : sizes.length === 0
              ? LEFT_OUT_WORDS.NO_SIZES
              : outside.length > 0
                ? sizesOutsideWords(outside, style.sizes)
                : null
      if (why) {
        leftOut.push({ lineId: line.id, seq: line.seq, why })
        continue
      }
      // The style's size order (the line keeps them as typed).
      const ordered = sizes.sort(([a], [b]) => style!.sizes.indexOf(a) - style!.sizes.indexOf(b)).map(([size, quantity]) => ({ size, quantity }))
      asks.push({ key: line.id, styleId: style!.id, colourwayId: colourway!.id, revisionId: null, sizes: ordered, wantedDate: wanted })
    }
    // Planning is asked only when a line can be dated (where the question is asked: the site's day, the delivery's market).
    let today = businessDate(now, site.timezone)
    let answers: AskAnswer[] = []
    if (asks.length > 0) {
      const shipTo = inquiry.shipToAddressId ? await db.partyAddress.findUnique({ where: { id: inquiry.shipToAddressId }, select: { country: true } }) : null
      const { where, view } = await whereOf(db, site, now, shipTo?.country ?? null)
      today = view.today
      answers = await answerPromises(db, where, asks)
    }
    const suggestion = suggestedAnswer(answers, leftOut.length, wanted, today)
    return {
      inquiry: { id: inquiry.id, number: inquiry.number, version: inquiry.version, wantedDate: wanted },
      site: { id: site.id, code: site.code, name: site.name },
      today,
      suggestion: { ...suggestion, week: suggestion.notBefore ? weekOf(suggestion.notBefore).key : null },
      lines: answers.map((answer) => {
        const line = lines.find((candidate) => candidate.id === answer.key)!
        return { lineId: line.id, seq: line.seq, date: answer.date, complete: answer.complete, meetsWanted: answer.meetsWanted, words: answer.words, warnings: answer.warnings.map((warning) => warning.words) }
      }),
      leftOut,
      current: await productionInRecord(db, inquiry, today),
    }
  })
}
