import type { FastifyRequest } from 'fastify'
import type { FactoryClient } from '@nexus/factory-db'
import { DomainError, ForbiddenError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, type Actor } from '@nexus/factory-domain/core/permissions'
import { BUSINESS_TIME_ZONE, businessDate, type BusinessDate } from '@nexus/factory-domain/core/time'
import { formatNumber } from '@nexus/factory-domain/numbering/format'
import { isFiscalKind, MAX_NUMBER, scopeKeyFor, yearOfScope, type DocumentKind } from '@nexus/factory-domain/numbering/kinds'
import { OVERRIDE_REFUSALS, PREVIEW_PERMISSIONS, seriesWouldIssue, typedNumberOf, typedNumberProblems, type OverridableKind, type OverrideRefusal } from '@nexus/factory-domain/numbering/override'
import { NUMBERING_OVERRIDE, NUMBERING_VIEW } from '@nexus/factory-domain/numbering/permissions'
import type { CommandTools, CommandTx } from '../../core/command'
import { actorOf, requireContext } from '../../core/context'
import { serverClock } from '../../core/time'
import type { NumberPreview, OverrideCheck } from './contract'

/**
 * The number preview and the controlled override (B-W2b-24; PLT-125; rules factory-domain numbering/override; design
 * admin.documents popup `override`, the W1 gap "no number preview for GR / LOT / PO"):
 *
 *   GET  /numbering/preview?companyId&kind[&code][&date]   the number a new document of the kind would get now — the
 *                                                          series' next one (a new year's first when the year changed),
 *                                                          NOT reserved: the document takes its number when it is saved.
 *                                                          numbering.view, or the permission that makes such a document
 *                                                          (PREVIEW_PERMISSIONS), over the company.
 *   POST /numbering/override/check                         "clashes refused at once": what typing this number for a
 *                                                          migrated document would meet (the kind, the shape, a document
 *                                                          that has it, the series giving it later). Read only.
 *                                                          numbering.override over the company.
 *   typedNumber(tools, …)                                  inside the command that makes the document, instead of
 *                                                          allocateNumber: the same checks again in its transaction, an
 *                                                          audit row `numbering.override` with the reason; the series'
 *                                                          counter does not move and no allocation is written (the number
 *                                                          is not the series'). A module takes it in its create body
 *                                                          (`typedNumber: { number, reason }`): B-W2b-24 wires purchase
 *                                                          orders (modules/purchasing insertDraft).
 */

type Reader = FactoryClient | CommandTx

/** Does a document of this kind have this number (in its company; a lot: in the tenant, lot codes are tenant-wide)? */
async function documentHas(db: Reader, kind: OverridableKind, companyId: string, number: string): Promise<boolean> {
  switch (kind) {
    case 'QUOTE':
      return (await db.quote.count({ where: { companyId, number } })) > 0
    case 'SALES_ORDER':
      return (await db.salesOrder.count({ where: { companyId, number } })) > 0
    case 'PURCHASE_ORDER':
      return (await db.purchaseOrder.count({ where: { companyId, number } })) > 0
    case 'WORK_ORDER':
      return (await db.workOrder.count({ where: { companyId, number } })) > 0
    case 'SUBCONTRACT':
      return (await db.subcontractOrder.count({ where: { companyId, number } })) > 0
    case 'LOT':
      return (await db.lot.count({ where: { code: number } })) > 0
  }
}

/** What typing this number meets, or null: the kind and shape first, then the documents and the series as they are now. */
export async function typedNumberRefusal(db: Reader, input: { readonly companyId: string; readonly kind: DocumentKind; readonly number: string }): Promise<OverrideRefusal | null> {
  const first = typedNumberProblems({ kind: input.kind, number: input.number })[0]
  if (first) return first.code
  const kind = input.kind as OverridableKind
  const number = typedNumberOf(input.number)
  // Issued by a series of this company and kind (a lot: of any company, as assertNumberUniqueInTenant reads it).
  const issued = await db.numberAllocation.count({ where: { kind, formatted: number, ...(kind === 'LOT' ? {} : { companyId: input.companyId }) } })
  if (issued > 0 || (await documentHas(db, kind, input.companyId, number))) return 'taken'
  const series = await db.numberSeries.findMany({ where: { companyId: input.companyId, kind, status: 'ACTIVE' }, select: { pattern: true, scopeKey: true, nextValue: true }, take: 50 })
  if (series.some((row) => seriesWouldIssue(row, number))) return 'future'
  return null
}

function officeActor(request: FastifyRequest): Actor {
  return actorOf(requireContext(request))
}

/** POST /numbering/override/check. */
export async function checkOverride(request: FastifyRequest, body: { companyId: string; kind: DocumentKind; number: string }): Promise<OverrideCheck> {
  const actor = officeActor(request)
  if (!can(actor, NUMBERING_OVERRIDE, { companyId: body.companyId })) throw new ForbiddenError()
  return request.withClient(async (client) => {
    const company = await client.company.findUnique({ where: { id: body.companyId }, select: { id: true } })
    if (!company) throw new NotFoundError('Company not found.')
    const code = await typedNumberRefusal(client, body)
    return { number: typedNumberOf(body.number), ok: code === null, refusal: code === null ? null : { code, message: OVERRIDE_REFUSALS[code] } }
  })
}

/** The issued-number shape a module keeps (allocateNumber's `formatted`), for a typed number. */
export interface TypedNumber {
  readonly formatted: string
  readonly kind: DocumentKind
  readonly typed: true
}

/**
 * Inside the document's command: the typed number of a migrated document, checked again in the transaction (a clash
 * that came meanwhile is refused), audited with its reason. 400 for the shape and the reason, 403 without
 * numbering.override over the company, 409 for a clash; each at `body/typedNumber/<code>` (codes: factory-domain
 * numbering/override OVERRIDE_REFUSALS; the web says its own words).
 */
export async function typedNumber(tools: Pick<CommandTools, 'tx' | 'context' | 'audit'>, series: { readonly companyId: string; readonly kind: DocumentKind }, record: { readonly type: string; readonly id: string }, typed: { readonly number: string; readonly reason: string }): Promise<TypedNumber> {
  const { tx, context, audit } = tools
  if (context.audience !== 'office') throw new ForbiddenError('A migrated document\'s number is typed in the office.')
  if (!can(actorOf(context), NUMBERING_OVERRIDE, { companyId: series.companyId })) throw new ForbiddenError('Typing a number for a migrated document needs numbering.override.')
  const problems = typedNumberProblems({ kind: series.kind, number: typed.number, reason: typed.reason })
  if (problems.length > 0) throw new ValidationError(problems[0]!.issue.message, problems.map((problem) => ({ path: `body/typedNumber/${problem.code}`, message: problem.issue.message })))
  const code = await typedNumberRefusal(tx, { companyId: series.companyId, kind: series.kind, number: typed.number })
  if (code) throw new DomainError('conflict', OVERRIDE_REFUSALS[code], [{ path: `body/typedNumber/${code}`, message: OVERRIDE_REFUSALS[code] }])
  const number = typedNumberOf(typed.number)
  audit({ action: 'numbering.override', recordType: record.type, recordId: record.id, companyId: series.companyId, after: { kind: series.kind, number, typed: true }, reason: typed.reason.trim() })
  return { formatted: number, kind: series.kind, typed: true }
}

// ---- the preview ------------------------------------------------------------------------------------------------------

/** Who may see the number a new document of this kind would get, in this company. */
export function mayPreview(actor: Actor, kind: DocumentKind, companyId: string): boolean {
  return can(actor, NUMBERING_VIEW, { companyId }) || (PREVIEW_PERMISSIONS[kind] ?? []).some((permission) => can(actor, permission, { companyId }))
}

/** The number the next document would get (allocateNumber's rule, read only; nothing is reserved). */
export async function previewOf(db: Reader, input: { readonly companyId: string; readonly kind: DocumentKind; readonly code?: string | undefined; readonly date: BusinessDate }): Promise<NumberPreview> {
  const base = { companyId: input.companyId, kind: input.kind, fiscal: isFiscalKind(input.kind), date: input.date }
  const none = (held: NumberPreview['held'], code: string | null = null): NumberPreview => ({ ...base, code, scopeKey: null, number: null, newPeriod: false, held })
  let code = input.code ?? null
  if (code === null) {
    const codes = await db.numberSeries.findMany({ where: { companyId: input.companyId, kind: input.kind, status: 'ACTIVE' }, select: { code: true }, distinct: ['code'], orderBy: { code: 'asc' } })
    if (codes.length === 0) return none('noSeries')
    if (codes.length > 1) return none('several')
    code = codes[0]!.code
  }
  const newest = await db.numberSeries.findFirst({ where: { companyId: input.companyId, kind: input.kind, code }, orderBy: { scopeKey: 'desc' }, select: { reset: true, scopeKey: true, pattern: true, status: true } })
  if (!newest) return none('noSeries', code)
  const scopeKey = scopeKeyFor(newest.reset, input.date)
  if (newest.reset === 'YEARLY' && scopeKey > newest.scopeKey) {
    if (newest.status !== 'ACTIVE') return { ...none('closed', code), scopeKey }
    return { ...base, code, scopeKey, number: formatNumber(newest.pattern, { value: 1, year: yearOfScope(scopeKey) }), newPeriod: true, held: null }
  }
  const row = await db.numberSeries.findFirst({ where: { companyId: input.companyId, kind: input.kind, code, scopeKey }, select: { pattern: true, nextValue: true, status: true } })
  if (!row) return { ...none('noSeries', code), scopeKey }
  if (row.status !== 'ACTIVE') return { ...none('closed', code), scopeKey }
  if (row.nextValue > MAX_NUMBER) return { ...none('exhausted', code), scopeKey }
  return { ...base, code, scopeKey, number: formatNumber(row.pattern, { value: row.nextValue, year: yearOfScope(scopeKey) }), newPeriod: false, held: null }
}

/** GET /numbering/preview. */
export async function previewNumber(request: FastifyRequest, query: { companyId: string; kind: DocumentKind; code?: string | undefined; date?: string | undefined }): Promise<{ preview: NumberPreview }> {
  const actor = officeActor(request)
  if (!isUuid(query.companyId)) throw new NotFoundError('Company not found.')
  if (!mayPreview(actor, query.kind, query.companyId)) throw new ForbiddenError()
  const date = query.date ?? businessDate(serverClock.now(), BUSINESS_TIME_ZONE)
  return request.withClient(async (client) => {
    const company = await client.company.findUnique({ where: { id: query.companyId }, select: { id: true } })
    if (!company) throw new NotFoundError('Company not found.')
    return { preview: await previewOf(client, { companyId: query.companyId, kind: query.kind, code: query.code, date }) }
  })
}
