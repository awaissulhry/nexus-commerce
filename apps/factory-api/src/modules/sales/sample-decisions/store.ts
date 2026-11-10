import type { Prisma } from '@nexus/factory-db'
import { PARTNERS_APPROVALS_ASK } from '@nexus/factory-domain/approvals-out/permissions'
import { ConflictError, ForbiddenError, NotFoundError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, type Permission } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import type { SwatchView } from '@nexus/factory-domain/sales/sample-decisions/contracts'
import { SALES_SAMPLES_DECIDE } from '@nexus/factory-domain/sales/sample-decisions/permissions'
import {
  noCompanyRefusal,
  swatchAskRefusal,
  swatchDecisionRefusal,
  swatchSentOnceRefusal,
  swatchSentRefusal,
  type DecisionRefusal,
  type SwatchFacts,
  type SwatchKind,
} from '@nexus/factory-domain/sales/sample-decisions/rules'
import { SALES_SAMPLES_MANAGE, SALES_SAMPLES_VIEW } from '@nexus/factory-domain/sales/samples/permissions'
import type { SampleDecision } from '@nexus/factory-domain/sales/samples/rules'
import type { CommandCaller } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { officeOf, type Reader } from '../samples/store'

/**
 * Sample decisions' rows (B-W2b-252; factory-db samples.prisma, B-W2b-212): the refusal every command throws in words, the
 * approval request that waits for the brand, the swatches (who may see which, the columns every read names, how rows become
 * the contracts' views). A round's own reads are B-W2b-246's (../samples/store: officeRound, readRoundRow, may,
 * databaseRefusal). A swatch has no company column: its company is its round's, else its style's (null for a tenant-wide
 * style's swatch of no round), and can() checks that company and its brand.
 */

/** A sample decision refused in words: 409 `conflict` with the issue `refusal/<CODE>`. */
export class DecisionRefusedError extends ConflictError {
  override name = 'DecisionRefusedError'
  override readonly issues: readonly Issue[]
  constructor(readonly refusal: DecisionRefusal) {
    super(refusal.message)
    this.issues = [{ path: `refusal/${refusal.code}`, message: refusal.message }]
  }
}

export const refuse = (refusal: DecisionRefusal | null): void => {
  if (refusal) throw new DecisionRefusedError(refusal)
}

/** "Read it again": a row changed since the caller read it. */
export const stale = (what: string, now: number): ConflictError => new ConflictError(`${what} changed since you read it (now version ${now}): read it again.`)

export type Scope = { readonly companyId: string | null; readonly partyId: string | null }
const scopeOf = (scope: Scope) => ({ ...(scope.companyId ? { companyId: scope.companyId } : {}), ...(scope.partyId ? { partyId: scope.partyId } : {}) })
export const mayOn = (context: OfficeContext, permission: Permission, scope: Scope): boolean => can(actorOf(context), permission, scopeOf(scope))

/** The permission the caller lacks among these (null: holds them all), for an action's `needs`. */
export const lacking = (context: OfficeContext, permissions: readonly Permission[], scope: Scope): Permission | null => permissions.find((permission) => !mayOn(context, permission, scope)) ?? null

export const action = (needs: Permission | null, refusal: DecisionRefusal | null) => ({ allowed: needs === null && refusal === null, refusal, needs })

/** The approval request of a record that waits for the brand (OPEN), the newest. */
export async function waitingRequest(db: Reader, recordType: 'SampleRound' | 'SampleSwatch', recordId: string): Promise<{ id: string; dueAt: Date; version: number } | null> {
  return db.approvalRequest.findFirst({ where: { recordType, recordId, status: 'OPEN' }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { id: true, dueAt: true, version: true } })
}

const at = (value: Date | null): string | null => (value ? toUtcIso(value) : null)
const ids = (values: readonly (string | null)[]): string[] => [...new Set(values.filter((value): value is string => value !== null))]
const byId = <Row extends { id: string }>(rows: readonly Row[]): Map<string, Row> => new Map(rows.map((row) => [row.id, row]))

/** People by id, display names (inside one record only). */
export async function namesOf(db: Reader, people: readonly (string | null)[]): Promise<Map<string, string>> {
  const wanted = ids(people)
  if (wanted.length === 0) return new Map()
  return new Map((await db.user.findMany({ where: { id: { in: wanted } }, select: { id: true, displayName: true } })).map((user) => [user.id, user.displayName]))
}

// ---- swatches -------------------------------------------------------------------------------------------------------------

export const SWATCH_COLUMNS = {
  id: true,
  styleId: true,
  roundId: true,
  partyId: true,
  kind: true,
  itemId: true,
  itemColourId: true,
  lotSiteId: true,
  lotId: true,
  note: true,
  sentAt: true,
  approvalRequestId: true,
  decision: true,
  decisionComments: true,
  decidedAt: true,
  decidedVia: true,
  decidedById: true,
  version: true,
  createdAt: true,
  createdById: true,
} as const satisfies Prisma.SampleSwatchSelect
export type SwatchData = Prisma.SampleSwatchGetPayload<{ select: typeof SWATCH_COLUMNS }>

export const swatchFacts = (row: SwatchData): SwatchFacts => ({ kind: row.kind as SwatchKind, sentAt: row.sentAt, decision: row.decision as SampleDecision | null })

export async function readSwatchRow(db: Reader, swatchId: string): Promise<SwatchData | null> {
  return isUuid(swatchId) ? db.sampleSwatch.findUnique({ where: { id: swatchId }, select: SWATCH_COLUMNS }) : null
}

/** A swatch's company: its round's, else its style's (null: a tenant-wide style's swatch of no round). */
export async function swatchCompanyOf(db: Reader, row: Pick<SwatchData, 'roundId' | 'styleId'>): Promise<string | null> {
  if (row.roundId) return (await db.sampleRound.findUnique({ where: { id: row.roundId }, select: { companyId: true } }))?.companyId ?? null
  return (await db.style.findUnique({ where: { id: row.styleId }, select: { companyId: true } }))?.companyId ?? null
}

/** The swatch the office caller sees (sales.samples.view over its company and brand, else not found). */
export async function officeSwatch(caller: CommandCaller, swatchId: string): Promise<{ context: OfficeContext; swatch: SwatchData; scope: Scope }> {
  const context = officeOf(caller)
  const found = await caller.withClient(async (db) => {
    const swatch = await readSwatchRow(db, swatchId)
    return swatch ? { swatch, companyId: await swatchCompanyOf(db, swatch) } : null
  })
  const scope = found ? { companyId: found.companyId, partyId: found.swatch.partyId } : null
  if (!found || !scope || !mayOn(context, SALES_SAMPLES_VIEW, scope)) throw new NotFoundError('Swatch not found.')
  return { context, swatch: found.swatch, scope }
}

export function requireOn(context: OfficeContext, permission: Permission, scope: Scope, words: string): void {
  if (!mayOn(context, permission, scope)) throw new ForbiddenError(`${words} (${permission}).`)
}

/** The swatches as the Approval tab and the list show them, their references read in one pass. */
export async function swatchViewsOf(db: Reader, context: OfficeContext, rows: readonly SwatchData[]): Promise<SwatchView[]> {
  if (rows.length === 0) return []
  const swatchIds = rows.map((row) => row.id)
  const [styles, rounds, parties, items, colours, lots, requests, waiting] = await Promise.all([
    db.style.findMany({ where: { id: { in: ids(rows.map((row) => row.styleId)) } }, select: { id: true, code: true, name: true, companyId: true } }),
    db.sampleRound.findMany({ where: { id: { in: ids(rows.map((row) => row.roundId)) } }, select: { id: true, number: true, companyId: true } }),
    db.party.findMany({ where: { id: { in: ids(rows.map((row) => row.partyId)) } }, select: { id: true, code: true, legalName: true, tradeName: true } }),
    db.item.findMany({ where: { id: { in: ids(rows.map((row) => row.itemId)) } }, select: { id: true, code: true, name: true, kind: true } }),
    db.itemColour.findMany({ where: { id: { in: ids(rows.map((row) => row.itemColourId)) } }, select: { id: true, code: true, name: true } }),
    db.lot.findMany({ where: { id: { in: ids(rows.map((row) => row.lotId)) } }, select: { id: true, siteId: true, code: true } }),
    db.approvalRequest.findMany({ where: { id: { in: ids(rows.map((row) => row.approvalRequestId)) } }, select: { id: true, typedName: true } }),
    db.approvalRequest.findMany({ where: { recordType: 'SampleSwatch', recordId: { in: swatchIds }, status: 'OPEN' }, select: { id: true, recordId: true, dueAt: true } }),
  ])
  const names = await namesOf(db, rows.map((row) => row.decidedById))
  const style = byId(styles)
  const round = byId(rounds)
  const partyOf = byId(parties)
  const item = byId(items)
  const colour = byId(colours)
  const lot = byId(lots)
  const request = byId(requests)
  const waitingOf = new Map(waiting.map((row) => [row.recordId, row]))
  return rows.map((row) => {
    const styleRow = style.get(row.styleId)
    const roundRow = row.roundId ? round.get(row.roundId) : undefined
    const companyId = roundRow?.companyId ?? styleRow?.companyId ?? null
    const scope = { companyId, partyId: row.partyId }
    const partyRow = partyOf.get(row.partyId)
    const itemRow = item.get(row.itemId)
    const colourRow = row.itemColourId ? colour.get(row.itemColourId) : undefined
    const lotRow = row.lotId ? lot.get(row.lotId) : undefined
    const open = waitingOf.get(row.id) ?? null
    const facts = swatchFacts(row)
    const manage = lacking(context, [SALES_SAMPLES_MANAGE], scope)
    return {
      id: row.id,
      styleId: row.styleId,
      style: { code: styleRow?.code ?? '', name: styleRow?.name ?? '' },
      roundId: row.roundId,
      roundNumber: roundRow?.number ?? null,
      party: { id: row.partyId, code: partyRow?.code ?? '', name: partyRow ? (partyRow.tradeName ?? partyRow.legalName) : '' },
      kind: row.kind as SwatchKind,
      item: { id: row.itemId, code: itemRow?.code ?? '', name: itemRow?.name ?? '', kind: itemRow?.kind ?? '' },
      itemColour: colourRow ?? null,
      lot: lotRow ?? null,
      note: row.note,
      sentAt: at(row.sentAt),
      approvalRequestId: row.approvalRequestId,
      decision: row.decision as SampleDecision | null,
      decisionComments: row.decisionComments,
      decidedAt: at(row.decidedAt),
      decidedVia: row.decidedVia,
      decidedBy: row.decidedById ? { id: row.decidedById, name: names.get(row.decidedById) ?? '' } : null,
      signedAs: row.decidedVia !== null && row.decidedVia !== 'OFFICE' && row.approvalRequestId ? (request.get(row.approvalRequestId)?.typedName ?? null) : null,
      waiting: open ? { requestId: open.id, dueAt: toUtcIso(open.dueAt) } : null,
      companyId,
      actions: {
        edit: action(manage, swatchSentRefusal(facts, 'change')),
        send: action(manage, row.sentAt ? swatchSentOnceRefusal(facts, new Date(0)) : null),
        remove: action(manage, swatchSentRefusal(facts, 'remove')),
        decide: action(lacking(context, [SALES_SAMPLES_DECIDE], scope), swatchDecisionRefusal(facts, open)),
        ask: action(lacking(context, [SALES_SAMPLES_DECIDE, PARTNERS_APPROVALS_ASK], scope), companyId === null ? noCompanyRefusal(styleRow?.code ?? '') : swatchAskRefusal(facts, row.kind, open)),
      },
      createdAt: toUtcIso(row.createdAt),
      version: row.version,
    }
  })
}
