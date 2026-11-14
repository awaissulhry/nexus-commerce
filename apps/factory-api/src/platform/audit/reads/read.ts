import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { AUDIT_READS_VIEW } from '@nexus/factory-domain/auth/permissions/catalogue'
import { NotFoundError, UnauthenticatedError, ValidationError } from '@nexus/factory-domain/core/errors'
import { parseInstant, toUtcIso } from '@nexus/factory-domain/core/time'
import { command, type CommandCaller } from '../../../core/command'
import type { PersonReadView, RecordReadView } from './contract'
import { assertEverywhere } from './everywhere'
import type { ReadLogRecordType } from './registry'

/**
 * Who looked (B-W2b-399; PLT-074; Owner answer W2b-6 question 3 = A): reads of the read log (contract.ts). Rows only: this
 * file counts nothing and groups nothing, so no figure about a person can come out of it (Statuto dei Lavoratori art. 4).
 */

const contextOf = (caller: CommandCaller) => {
  if (!caller.factoryContext) throw new UnauthenticatedError()
  return caller.factoryContext
}

const WORDS = 'Who looked at sensitive records is read by the administrators and the Owner only (audit.reads.view over every company).'

const READ_SELECT = { id: true, at: true, action: true, surface: true, userId: true, recordType: true, recordId: true } as const satisfies Prisma.ReadLogSelect

interface Page {
  readonly before?: string | undefined
  readonly limit: number
}

/** Rows older than the anchor (newest first), or a ValidationError for an anchor that is not a row of this list. */
async function pageWhere(client: FactoryClient, where: Prisma.ReadLogWhereInput, before: string | undefined): Promise<Prisma.ReadLogWhereInput> {
  if (!before) return {}
  const anchor = await client.readLog.findFirst({ where: { AND: [where, { id: before }] }, select: { id: true, at: true } })
  if (!anchor) throw new ValidationError('No such read to page from.', [{ path: 'before', message: 'Not a read of this list.' }])
  return { OR: [{ at: { lt: anchor.at } }, { at: anchor.at, id: { lt: anchor.id } }] }
}

async function pageOf(client: FactoryClient, where: Prisma.ReadLogWhereInput, page: Page) {
  const rows = await client.readLog.findMany({ where: { AND: [where, await pageWhere(client, where, page.before)] }, orderBy: [{ at: 'desc' }, { id: 'desc' }], take: page.limit + 1, select: READ_SELECT })
  const more = rows.length > page.limit
  const shown = more ? rows.slice(0, page.limit) : rows
  return { shown, nextBefore: more ? shown[shown.length - 1]!.id : null }
}

/** GET /audit/reads: the reads of one record. */
export async function recordReads(caller: CommandCaller, query: Page & { readonly recordType: ReadLogRecordType; readonly recordId: string }): Promise<{ reads: RecordReadView[]; nextBefore: string | null }> {
  assertEverywhere(contextOf(caller), AUDIT_READS_VIEW, WORDS)
  return caller.withClient(async (client) => {
    const { shown, nextBefore } = await pageOf(client, { recordType: query.recordType, recordId: query.recordId }, query)
    const readers = [...new Set(shown.map((row) => row.userId))]
    const names = new Map((readers.length > 0 ? await client.user.findMany({ where: { id: { in: readers } }, select: { id: true, displayName: true } }) : []).map((user) => [user.id, user.displayName]))
    return {
      reads: shown.map((row) => ({ id: row.id, at: toUtcIso(row.at), action: row.action, surface: row.surface as RecordReadView['surface'], reader: { id: row.userId, name: names.get(row.userId) ?? null } })),
      nextBefore,
    }
  })
}

function instantOf(value: string | undefined, path: string): Date | undefined {
  if (value === undefined) return undefined
  const parsed = parseInstant(value)
  if (parsed === null) throw new ValidationError('Not a time.', [{ path: `body/${path}`, message: 'Expected an ISO 8601 time with a zone.' }])
  return parsed
}

/**
 * POST /audit/reads/person: one person's reads, only with a reason. The reason is written first, in its own command (an audit
 * row on the person: who searched, why, the time window), and the rows are read after it commits, so they never enter the
 * command's receipt.
 */
export async function personReads(
  caller: CommandCaller,
  body: Page & { readonly userId: string; readonly reason: string; readonly from?: string | undefined; readonly to?: string | undefined },
  idempotencyKey: string | undefined,
): Promise<{ person: { id: string; name: string }; reads: PersonReadView[]; nextBefore: string | null }> {
  assertEverywhere(contextOf(caller), AUDIT_READS_VIEW, WORDS)
  const from = instantOf(body.from, 'from')
  const to = instantOf(body.to, 'to')
  const person = await caller.withClient((client) => client.user.findFirst({ where: { id: body.userId, audience: 'OFFICE' }, select: { id: true, displayName: true } }))
  if (!person) throw new NotFoundError('No office person with this id.')
  await command(caller, { name: 'audit.searchReadsOfPerson', idempotencyKey, input: { userId: person.id, reason: body.reason, from: body.from ?? null, to: body.to ?? null, before: body.before ?? null } }, async (tools) => {
    tools.audit({ recordType: 'User', recordId: person.id, companyId: null, reason: body.reason, after: { searched: 'reads', from: from ? toUtcIso(from) : null, to: to ? toUtcIso(to) : null } })
    return { searched: true }
  })
  return caller.withClient(async (client) => {
    const where: Prisma.ReadLogWhereInput = { userId: person.id, ...(from || to ? { at: { ...(from ? { gte: from } : {}), ...(to ? { lt: to } : {}) } } : {}) }
    const { shown, nextBefore } = await pageOf(client, where, body)
    return {
      person: { id: person.id, name: person.displayName },
      reads: shown.map((row) => ({ id: row.id, at: toUtcIso(row.at), action: row.action, surface: row.surface as PersonReadView['surface'], record: { type: row.recordType as ReadLogRecordType, id: row.recordId } })),
      nextBefore,
    }
  })
}
