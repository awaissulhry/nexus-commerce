import type { Prisma } from '@nexus/factory-db'
import { CLAIMS_APPROVE, CLAIMS_MANAGE } from '@nexus/factory-domain/compliance/claims/permissions'
import { CLAIM_LIMITS, CLAIMS_LAW, GENERIC_LAW, LABEL_LAW, nextCode, OFFSET_LAW, wordingCheck, type ClaimKind, type ClaimScope, type ClaimState } from '@nexus/factory-domain/compliance/claims/rules'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import type { CommandCaller } from '../../../core/command'
import type { OfficeContext } from '../../../core/context'
import { peopleNames } from '../../../platform/alerts/store'
import { CLAIM_CHECK_KEY } from './gate-plug'
import { CLAIM_SELECT, claimScope, claimViews, holdsHere, mayRead, officeOf, todayOf, useViews, USE_SELECT, type ClaimRow, type ClaimView, type Reader } from './store'

/**
 * The claims register's reads (B-W2b-264; PRD-380; design compliance.sourcing), office only, compliance.certificates.view,
 * each claim checked against its company:
 *
 *   GET /compliance/claims             the claims (`state` current | all | DRAFT | APPROVED | BLOCKED | RETIRED, `kind`,
 *                                      `scope`, `q`), with what each reads as today
 *   GET /compliance/claims/counts      the tiles: approved and holding, blocked (evidence no longer holds), drafts, retired
 *   GET /compliance/claims/:id         one claim with every use (live and ended), its activity and the wording checker's
 *                                      findings per language
 *   GET /compliance/claims/choices     the New claim dialog's choices (manage): evidence files of the company, styles,
 *                                      materials, label templates, the claim phrases, the next free code
 */

export const LAW = { claims: CLAIMS_LAW, generic: GENERIC_LAW, offset: OFFSET_LAW, label: LABEL_LAW }
export const CLAIM_NOT_FOUND = 'Claim not found.'
/** The seeded requirement that switches the claims' check at label print (B-W2b-222). */
export const CLAIM_REQUIREMENT_CODE = 'CLAIM-EVIDENCE'

const byCode = (a: ClaimView, b: ClaimView): number => a.code.localeCompare(b.code, 'it', { numeric: true, sensitivity: 'base' }) || a.id.localeCompare(b.id)

/** Every claim of the scope the caller reads (with one more row: whether the list is complete). */
async function registerOf(db: Reader, context: OfficeContext, where: Prisma.SustainabilityClaimWhereInput, today: BusinessDate) {
  const rows = (await db.sustainabilityClaim.findMany({ where: { AND: [claimScope(context), where] }, take: CLAIM_LIMITS.list + 1, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: CLAIM_SELECT })) as ClaimRow[]
  const complete = rows.length <= CLAIM_LIMITS.list
  return { views: (await claimViews(db, context, rows.slice(0, CLAIM_LIMITS.list), today)).sort(byCode), complete }
}

export interface ListQuery {
  readonly state?: 'current' | 'all' | ClaimState | undefined
  readonly kind?: ClaimKind | undefined
  readonly scope?: ClaimScope | undefined
  readonly q?: string | undefined
  readonly limit?: number | undefined
}

const statusesOf = (state: ListQuery['state']): Prisma.SustainabilityClaimWhereInput => {
  switch (state ?? 'current') {
    case 'all':
      return {}
    case 'current':
      return { status: { in: ['DRAFT', 'APPROVED'] } }
    case 'DRAFT':
      return { status: 'DRAFT' }
    case 'RETIRED':
      return { status: 'WITHDRAWN' }
    default:
      return { status: 'APPROVED' }
  }
}

/**
 * Whether label print checks the claims: B-W2b-222's requirement CLAIM-EVIDENCE (checkKey claims.evidence, blocking LABEL_PRINT),
 * seeded OFF until a style or a market needs green claims (Owner answer 11-09, Q23 / Q5 = A). A tenant without the row: NONE
 * (the Owner adds it in Rules & markets › Gates, B-W2b-265).
 */
async function labelCheckOf(db: Reader): Promise<'ON' | 'OFF' | 'NONE'> {
  const row = await db.complianceRequirement.findFirst({ where: { OR: [{ code: CLAIM_REQUIREMENT_CODE }, { checkKey: CLAIM_CHECK_KEY, status: 'ACTIVE' }] }, orderBy: [{ switchedOn: 'desc' }, { code: 'asc' }], select: { switchedOn: true, status: true } })
  if (!row) return 'NONE'
  return row.switchedOn && row.status === 'ACTIVE' ? 'ON' : 'OFF'
}

/** Whether a claim holds the words typed: its code, words in any language, scope note, phrase, style or material. */
const matches = (view: ClaimView, needle: string): boolean =>
  [view.code, view.scopeNote, view.phraseKey, view.style?.code, view.style?.name, view.material?.code, view.material?.name, ...Object.values(view.wording)].some((text) => !!text && text.toLocaleLowerCase('it').includes(needle))

/** The claims, filtered as the list's address asks (the export reads the same). */
export async function listClaims(caller: CommandCaller, query: ListQuery) {
  const context = officeOf(caller)
  const today = todayOf()
  return caller.withClient(async (client) => {
    const where: Prisma.SustainabilityClaimWhereInput = { AND: [statusesOf(query.state), query.kind ? { kind: query.kind } : {}, query.scope ? { scope: query.scope } : {}] }
    const { views, complete } = await registerOf(client, context, where, today)
    const state = query.state ?? 'current'
    const needle = (query.q ?? '').trim().toLocaleLowerCase('it')
    const filtered = views.filter((view) => (state === 'APPROVED' || state === 'BLOCKED' ? view.state === state : true) && (needle === '' || matches(view, needle)))
    const limit = query.limit ?? CLAIM_LIMITS.list
    return {
      claims: filtered.slice(0, limit),
      complete: complete && filtered.length <= limit,
      canManage: holdsHere(context, CLAIMS_MANAGE),
      canApprove: holdsHere(context, CLAIMS_APPROVE),
      today,
      law: LAW,
      labelCheck: await labelCheckOf(client),
    }
  })
}

/** GET /compliance/claims/counts: the tiles count from the same rows. */
export async function claimCounts(caller: CommandCaller) {
  const context = officeOf(caller)
  const today = todayOf()
  return caller.withClient(async (client) => {
    const { views } = await registerOf(client, context, {}, today)
    return {
      approved: views.filter((view) => view.state === 'APPROVED').length,
      blocked: views.filter((view) => view.state === 'BLOCKED').length,
      drafts: views.filter((view) => view.state === 'DRAFT').length,
      retired: views.filter((view) => view.state === 'RETIRED').length,
    }
  })
}

/** One claim the caller reads, or the one 404. */
export async function readClaimRow(db: Reader, context: OfficeContext, claimId: string): Promise<ClaimRow> {
  if (!isUuid(claimId)) throw new NotFoundError(CLAIM_NOT_FOUND)
  const row = (await db.sustainabilityClaim.findUnique({ where: { id: claimId }, select: CLAIM_SELECT })) as ClaimRow | null
  if (!row || !mayRead(context, row.companyId) || (context.companyId && context.companyId !== row.companyId)) throw new NotFoundError(CLAIM_NOT_FOUND)
  return row
}

type Facts = Record<string, string | number | boolean | null | string[]>

/** The facts of an audit row worth saying (codes and short words only: never a whole record). */
function factsOf(after: Prisma.JsonValue | null): Facts {
  const facts: Facts = {}
  if (!after || typeof after !== 'object' || Array.isArray(after)) return facts
  for (const key of ['status', 'kind', 'label', 'recordType', 'useId', 'code', 'since', 'replacedBy', 'replaces', 'usesEnded', 'usesMoved', 'validUntil', 'scope']) {
    const value = (after as Record<string, Prisma.JsonValue>)[key]
    if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') facts[key] = value
  }
  const causes = (after as Record<string, Prisma.JsonValue>).causes
  if (Array.isArray(causes)) facts.causes = causes.filter((value): value is string => typeof value === 'string')
  const languages = (after as Record<string, Prisma.JsonValue>).wording
  if (languages && typeof languages === 'object' && !Array.isArray(languages)) facts.languages = Object.keys(languages)
  return facts
}

/** GET /compliance/claims/:id: the claim, every use, the activity (newest first), the checker's findings. */
export async function claimRecord(caller: CommandCaller, claimId: string) {
  const context = officeOf(caller)
  const today = todayOf()
  return caller.withClient(async (client) => {
    const row = await readClaimRow(client, context, claimId)
    const [claim] = await claimViews(client, context, [row], today)
    const uses = await client.claimUse.findMany({ where: { claimId: row.id }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: USE_SELECT })
    const audits = await client.auditLog.findMany({ where: { recordType: 'SustainabilityClaim', recordId: row.id }, orderBy: [{ at: 'desc' }, { id: 'desc' }], take: 200, select: { id: true, at: true, action: true, actorId: true, audience: true, reason: true, after: true } })
    const names = await peopleNames(client, audits.filter((entry) => entry.audience === 'OFFICE').map((entry) => entry.actorId))
    return {
      claim: claim!,
      uses: await useViews(client, uses),
      activity: audits.map((entry) => ({
        id: entry.id,
        at: toUtcIso(entry.at),
        action: entry.action,
        by: entry.audience === 'OFFICE' ? { id: entry.actorId, name: names.get(entry.actorId) ?? '?' } : null,
        reason: entry.reason,
        facts: factsOf(entry.after),
      })),
      findings: wordingCheck(claim!.wording, claim!.kind),
      today,
      law: LAW,
    }
  })
}

const EVIDENCE_CATEGORIES = ['SUPPLIER_CERTIFICATE', 'TEST_REPORT', 'DECLARATION'] as const

/** GET /compliance/claims/choices: what New claim and Where used choose from, for the screen's company. */
export async function claimChoices(caller: CommandCaller, query: { readonly q?: string | undefined }) {
  const context = officeOf(caller)
  return caller.withClient(async (client) => {
    const company = context.companyId ? { OR: [{ companyId: null }, { companyId: context.companyId }] } : {}
    const words = (query.q ?? '').trim()
    const files = await client.storedFile.findMany({
      where: {
        AND: [
          company,
          { status: 'AVAILABLE', supersededAt: null },
          { OR: [{ kind: 'CERTIFICATE' }, { category: { in: [...EVIDENCE_CATEGORIES] } }, { recordType: 'SustainabilityClaim' }] },
          words ? { originalName: { contains: words, mode: 'insensitive' } } : {},
        ],
      },
      orderBy: [{ availableAt: 'desc' }, { id: 'desc' }],
      take: CLAIM_LIMITS.choices,
      select: { id: true, originalName: true, kind: true, category: true, recordType: true, recordId: true, expiresOn: true, availableAt: true },
    })
    const styles = await client.style.findMany({ where: { AND: [company, { status: { not: 'ARCHIVED' } }] }, orderBy: [{ code: 'asc' }, { id: 'asc' }], take: CLAIM_LIMITS.list, select: { id: true, code: true, name: true } })
    const materials = await client.item.findMany({ where: { AND: [company, { status: 'ACTIVE', kind: { not: 'FINISHED' } }] }, orderBy: [{ code: 'asc' }, { id: 'asc' }], take: CLAIM_LIMITS.list, select: { id: true, code: true, name: true } })
    const labels = await client.labelTemplate.findMany({ where: { AND: [company, { status: { not: 'RETIRED' } }] }, orderBy: [{ code: 'asc' }, { id: 'asc' }], take: CLAIM_LIMITS.list, select: { id: true, code: true, name: true, styleId: true } })
    const phrases = await client.phrase.findMany({ where: { AND: [company, { kind: 'CLAIM', status: 'ACTIVE' }] }, orderBy: [{ key: 'asc' }], take: CLAIM_LIMITS.choices, select: { key: true, sourceText: true, sourceLanguage: true } })
    const codes = await client.sustainabilityClaim.findMany({ where: context.companyId ? { companyId: context.companyId } : {}, select: { code: true } })
    return {
      files: files.map((file) => ({ id: file.id, name: file.originalName, kind: file.kind, category: file.category, recordType: file.recordType, recordId: file.recordId, expiresOn: file.expiresOn ? file.expiresOn.toISOString().slice(0, 10) : null, availableAt: file.availableAt ? toUtcIso(file.availableAt) : null })),
      styles,
      materials,
      labels,
      phrases: phrases.map((phrase) => ({ key: phrase.key, text: phrase.sourceText, language: phrase.sourceLanguage })),
      nextCode: nextCode(codes.map((row) => row.code)),
    }
  })
}
