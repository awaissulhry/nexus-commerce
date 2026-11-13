import { createHash } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { InvalidStateError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { fitProblems, remakeHeld, remakeReasonNote, remakeReasonOf, remakeSentWords, type RemakeChannel } from '@nexus/factory-domain/sales/returns-outcomes/rules'
import { SALES_RETURNS_MANAGE } from '@nexus/factory-domain/sales/returns/permissions'
import { RETURN_REASON_LIST, type ReturnStatus } from '@nexus/factory-domain/sales/returns/rules'
import { command, idempotencyKeyFrom, type CommandCaller, type CommandSpec, type CommandTools } from '../../../core/command'
import { portalOf } from '../../../platform/auth/portal/service'
import { systemCallerOf } from '../../../platform/files/files'
import { dropLinkDraft } from '../../../platform/links/drafts'
import { linkCommand, useLink } from '../../../platform/links/use'
import { appClock, commandOn } from '../../../platform/portal/tasks/clock'
import { activeReasonCodes } from '../../../platform/reasons/service'
import { assertMayRequest, portalReader, type PortalReader } from '../portal-returns/access'
import { aboveSoldError, answerByFor, createRequestInCommand, NO_SCOPE, planRequest, refuse, type ClaimScope, type ReturnRequestBody } from '../portal-returns/create'
import { claimLinkOf, linkClaim, LINK_CASE_ACTION, scopeOf } from '../portal-returns/link'
import { portalReturn } from '../portal-returns/portal'
import type { Place, Reader } from '../portal-returns/store'
import { officeReturn } from '../returns/access'
import { lockReturn, touchReturn } from '../returns/rma'
import { readLines } from '../returns/store'
import { outcomesOf, type OutcomesView } from './outcomes'
import { REMAKE_ACTION, remakeOf, RETURN_RECORD } from './store'
// B-W2b-368 (XF1:03): the RMA records the customer's wish REMAKE (wave 45's ReturnOutcomeWanted).
import { REMAKE_WISH } from '../returns/outcomes/remake'

/**
 * A remake asked with photos (B-W2b-346; SAL-298 "Remake request with photos"; design links.claim "Remake (made-to-measure
 * fit)": what is wrong with the fit + front and back photos; follow-ups RX2:01 the claim link offers Remake, RX2:02 the
 * portal's new return offers Remake). Three doors, one record: the RMA, its line for the item, and the audit row
 * `returnsOutcomes.remakeAsked` (the lines it is for, how it came, the fit in words) written in the command that asks it, with
 * event return.remake_asked; B-W2b-368: and the RMA's wish REMAKE (ReturnOutcomeWanted since wave 45).
 *
 *   office  `POST /sales/returns/:returnId/remake` {version, lineIds, fit} on an RMA the office made (REQUESTED, AUTHORISED or
 *           RECEIVED, its lines not decided; once per RMA): sales.returns.manage. The photos are W2a's line photos.
 *   portal  `POST /portal/returns/remake` {lines: [one item], fit, customerRef?}: an RMA REQUESTED made as the person (B-W2b-192's
 *           createRequestInCommand: what may come back, never more than was sold), the line's reason the first active of
 *           WRONG_SIZE, OTHER (the fit's first words as its reason words), the fit as the RMA's customerNote; portal.returns
 *           .request (checked here, in words). The answer = the return's record (B-W2b-192's view) and `sent`. The front and
 *           back photos then go onto its line (`POST /portal/returns/:id/photos` with the lineId).
 *   link    `POST /link/claim/remake` {lines, fit, customerRef?, typedName?} on a CLAIM link: checked first (a refusal uses
 *           nothing), the link used in its own command (a counted use), then ONE system command makes the same RMA, drops
 *           the link's draft and notes the case on the link as B-W2b-192's claims do (`portalReturns.linkCase`), so the
 *           link's photos, cases and instructions routes take it. The answer = the claim page and `sent`.
 */

/** One item of what the customer received; its reason is the remake's (the fit). */
export type RemakeLine = Omit<ReturnRequestBody['lines'][number], 'reasonCode' | 'reasonNote'>

export interface RemakeBody {
  readonly lines: readonly RemakeLine[]
  readonly fit: string
  readonly customerRef?: string | null | undefined
}

const issues = (problems: readonly Issue[], words: string): never => {
  throw new ValidationError(problems.length === 1 ? problems[0]!.message : words, problems)
}

/** The audit row and the event of a remake asked (inside the caller's command). */
export function remakeAskedInCommand(tools: CommandTools, rma: { readonly id: string; readonly number: string; readonly companyId: string; readonly siteId: string }, lineIds: readonly string[], via: RemakeChannel, fit: string): void {
  tools.audit({ action: REMAKE_ACTION, recordType: RETURN_RECORD, recordId: rma.id, companyId: rma.companyId, siteId: rma.siteId, after: { lineIds: [...lineIds], via, fit: fit.trim() } })
  tools.emit({ type: 'return.remake_asked', subject: rma.id, companyId: rma.companyId, siteId: rma.siteId, payload: { returnId: rma.id, number: rma.number, lineIds: [...lineIds], via } })
}

// ---- the office ------------------------------------------------------------------------------------------------------

/** POST /sales/returns/:returnId/remake */
export async function askRemake(caller: CommandCaller, returnId: string, body: { readonly version: number; readonly lineIds: readonly string[]; readonly fit: string }, idempotencyKey?: string): Promise<{ return: OutcomesView }> {
  const { rma: seen } = await officeReturn(caller, returnId, SALES_RETURNS_MANAGE)
  const shape = fitProblems(body.fit, 'body/fit')
  if (body.lineIds.length === 0) shape.push({ path: 'body/lineIds', message: 'Pick the line (or lines) the remake is for.' })
  if (shape.length > 0) issues(shape, 'The remake cannot be asked like this.')
  await command(caller, { name: 'returnsOutcomes.askRemake', idempotencyKey, input: { returnId, ...body } }, async (tools) => {
    const { tx } = tools
    const rma = await lockReturn(tools, seen.id, body.version, ['REQUESTED', 'AUTHORISED', 'RECEIVED', 'INSPECTED'], 'a remake is asked')
    const held = remakeHeld({ status: rma.status as ReturnStatus, asked: (await remakeOf(tx, rma.id)) !== null })
    if (held) throw new InvalidStateError(held)
    const lines = await readLines(tx, rma.id)
    const problems: Issue[] = []
    for (const [index, lineId] of body.lineIds.entries()) {
      const line = lines.find((entry) => entry.id === lineId)
      if (!line) problems.push({ path: `body/lineIds/${index}`, message: 'Not a line of this return.' })
      else if (body.lineIds.indexOf(lineId) !== index) problems.push({ path: `body/lineIds/${index}`, message: `Line ${line.seq} is named twice.` })
      else if (line.disposition !== null) problems.push({ path: `body/lineIds/${index}`, message: `Line ${line.seq} is decided already.` })
      else if (line.creditWithoutReturn) problems.push({ path: `body/lineIds/${index}`, message: `Line ${line.seq} was credited without the goods: nothing is made again of it.` })
    }
    if (problems.length > 0) issues(problems, 'Some lines cannot take a remake.')
    await touchReturn(tools, rma, REMAKE_WISH) // B-W2b-368: the wish REMAKE (REQUESTED, AUTHORISED or RECEIVED: remakeHeld above)
    remakeAskedInCommand(tools, rma, body.lineIds, 'OFFICE', body.fit)
    return null
  })
  return { return: await outcomesOf(caller, seen.id) }
}

// ---- the request from outside ---------------------------------------------------------------------------------------

/** The return request a remake makes: one item, the remake's reason, the fit as the customer's words. */
async function requestOf(db: Reader, body: RemakeBody): Promise<{ request: ReturnRequestBody; problems: Issue[] }> {
  const problems = fitProblems(body.fit, 'body/fit')
  if (body.lines.length !== 1) problems.push({ path: 'body/lines', message: 'Pick the one item that is made again.' })
  const reasonCode = remakeReasonOf(await activeReasonCodes(db, RETURN_REASON_LIST))
  if (!reasonCode) problems.push({ path: 'body/lines', message: 'Remakes cannot be asked now: write to us in the messages.' })
  const note = remakeReasonNote(body.fit)
  return {
    request: { lines: body.lines.map((line) => ({ ...line, reasonCode: reasonCode ?? '', reasonNote: note })), outcomeWanted: null, customerRef: body.customerRef ?? null, note: body.fit.trim() },
    problems,
  }
}

async function remakeInCommand(tools: CommandTools, place: Place, scope: ClaimScope, request: ReturnRequestBody, fit: string, who: { readonly via: 'PORTAL' | 'LINK'; readonly personId: string | null; readonly linkId: string | null }) {
  const made = await createRequestInCommand(tools, place, scope, request, who)
  // B-W2b-368: the request's wish is REMAKE (a request from outside offers REPLACE, REPAIR or CREDIT; the remake sets its own).
  const row = await tools.tx.returnAuthorisation.update({ where: { id: made.returnId }, data: REMAKE_WISH, select: { siteId: true } })
  remakeAskedInCommand(tools, { id: made.returnId, number: made.number, companyId: place.companyId, siteId: row.siteId }, made.lineIds, who.via, fit)
  return made
}

/** ONE command in the tenant's office scope as the portal person (B-W2b-192's portal.ts does the same). */
function asPerson<Result>(app: FastifyInstance, request: FastifyRequest, reader: PortalReader, spec: CommandSpec, work: (tools: CommandTools) => Promise<Result>) {
  const auth = portalOf(app).auth
  return auth.command(auth.contextFor(request, reader.session.tenantId, reader.session.userId), spec, work)
}

/** POST /portal/returns/remake */
export async function portalAskRemake(app: FastifyInstance, request: FastifyRequest, body: RemakeBody, idempotencyKey?: string) {
  const reader = portalReader(app, request)
  assertMayRequest(reader)
  const now = appClock(app).now()
  const { request: asked, problems } = await reader.inTenant((db) => requestOf(db, body))
  if (problems.length > 0) issues(problems, 'The remake request cannot be sent like this.')
  const { result } = await asPerson(app, request, reader, { name: 'returnsOutcomes.portalRemake', idempotencyKey, input: { ...body, sessionId: reader.session.id } }, (tools) =>
    remakeInCommand(tools, reader.place, NO_SCOPE, asked, body.fit, { via: 'PORTAL', personId: reader.session.userId, linkId: null }),
  )
  const answerBy = await reader.inTenant((db) => answerByFor(db, reader.place.companyId, now))
  return { ...(await portalReturn(app, request, result.returnId)), sent: { number: result.number, answerBy, words: remakeSentWords(result.number, answerBy) } }
}

/** POST /link/claim/remake?language= */
export async function linkAskRemake(app: FastifyInstance, request: FastifyRequest, body: RemakeBody & { readonly typedName?: string | null | undefined }, language?: 'it' | 'en') {
  const link = claimLinkOf(request)
  const place: Place = { companyId: link.companyId, partyId: link.partyId }
  const system = systemCallerOf(request)(link.tenantId)
  const now = appClock(app).now()
  const scope = await system.withClient((db) => scopeOf(db, link))
  // Checked before the link is used: a request that cannot go uses nothing.
  const { request: asked, problems } = await system.withClient((db) => requestOf(db, body))
  if (problems.length > 0) issues(problems, 'The remake request cannot be sent like this.')
  const checked = await system.withClient((db) => planRequest(db, place, scope, asked, now))
  if (checked.problems.length > 0) refuse(checked.problems, 'The remake request cannot be sent like this.')
  if (checked.aboveSold.length > 0) throw aboveSoldError(checked.aboveSold)
  const key = idempotencyKeyFrom(request)
  const use = await linkCommand(request, { name: 'returnsOutcomes.remakeSubmit', idempotencyKey: key, input: { type: 'REMAKE' } }, async (tools) => {
    const used = await useLink(tools, request, { action: 'submit', typedName: body.typedName ?? null })
    return { evidenceId: used.evidenceId, usesLeft: used.usesLeft }
  })
  const { result } = await commandOn(app, system, { name: 'returnsOutcomes.linkRemake', idempotencyKey: key ? `remake.${createHash('sha256').update(`${link.id}|${key}`).digest('hex').slice(0, 48)}` : undefined, input: { linkId: link.id, ...body } }, async (tools) => {
    const made = await remakeInCommand(tools, place, scope, asked, body.fit, { via: 'LINK', personId: null, linkId: link.id })
    await dropLinkDraft(tools, link.id)
    tools.audit({ action: LINK_CASE_ACTION, recordType: 'OneOffLink', recordId: link.id, companyId: link.companyId, after: { caseType: RETURN_RECORD, caseId: made.returnId, number: made.number, evidenceId: use.result.evidenceId, remake: true } })
    return made
  })
  const answerBy = await system.withClient((db) => answerByFor(db, place.companyId, now))
  const page = await linkClaim(app, request, language)
  return { ...page, link: { ...page.link, usesLeft: use.result.usesLeft }, sent: { type: 'RETURN' as const, id: result.returnId, number: result.number, answerBy, words: remakeSentWords(result.number, answerBy) } }
}
