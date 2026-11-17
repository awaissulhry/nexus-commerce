import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { THREADS_POST, THREADS_READ } from '@nexus/factory-domain/auth/permissions/catalogue'
import { ConflictError, DomainError, ForbiddenError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, scopeWhere, type Actor, type ScopedRecord } from '@nexus/factory-domain/core/permissions'
import { PROJECTS_MANAGE } from '@nexus/factory-domain/projects/permissions'
import { PROJECT_REFUSALS, type ProjectRefusalCode, type ProjectStatus } from '@nexus/factory-domain/projects/rules'
import type { CommandCaller, CommandTx } from '../../../core/command'
import { actorOf, type OfficeContext, type RequestContext } from '../../../core/context'
import { mayOnThread } from '../../../platform/threads/records'

/**
 * Projects (threads plan TH-5, B-TH-066 … B-TH-073): the reads and checks every projects file shares. A project is read with
 * threads.read over its company and its outside company (the record thread's own rule: platform/threads records.ts
 * `mayOnThread`), kept with projects.manage over the same scope. A project the caller may not read is NOT FOUND (never "you may
 * not"): a person limited to brand A never learns that brand B's project exists (W38). Every refusal is in words at
 * `refusal/<CODE>` (factory-domain projects/rules PROJECT_REFUSALS), never naming another customer.
 */

export type Reader = FactoryClient | CommandTx

export const PROJECT_COLUMNS = {
  id: true,
  companyId: true,
  number: true,
  name: true,
  goal: true,
  leadId: true,
  partyId: true,
  seasonCode: true,
  targetDate: true,
  status: true,
  outcome: true,
  outcomeNote: true,
  closedAt: true,
  closedById: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  createdById: true,
} as const satisfies Prisma.ProjectSelect

export type ProjectRow = Prisma.ProjectGetPayload<{ select: typeof PROJECT_COLUMNS }>

/** The office context, or 403 (projects are the office's; the portal reads them through its partner view). */
export function officeOf(caller: Pick<CommandCaller, 'factoryContext'>): OfficeContext {
  const context = caller.factoryContext
  if (!context || context.audience !== 'office') throw new ForbiddenError()
  return context
}

/** The tenant of a command's context (a project's commands run as the office or the system, never the platform). */
export function tenantOf(context: RequestContext): string {
  if (context.audience === 'platform') throw new ForbiddenError()
  return context.tenantId
}

/** A project's scope: its company and its outside company (no site). */
export const scopeOf = (row: Pick<ProjectRow, 'companyId' | 'partyId'>): ScopedRecord => ({ companyId: row.companyId, siteId: null, partyId: row.partyId })

/** Whether the actor reads the project (threads.read over it, as its thread). */
export const mayRead = (actor: Actor, row: Pick<ProjectRow, 'companyId' | 'partyId'>): boolean => mayOnThread(actor, THREADS_READ, 'Project', scopeOf(row))
/** Whether the actor writes in its thread and adds a colleague (threads.post over it). */
export const mayPost = (actor: Actor, row: Pick<ProjectRow, 'companyId' | 'partyId'>): boolean => mayOnThread(actor, THREADS_POST, 'Project', scopeOf(row))
/** Whether the actor keeps it (projects.manage over it). */
export const mayManage = (actor: Actor, row: Pick<ProjectRow, 'companyId' | 'partyId'>): boolean => can(actor, PROJECTS_MANAGE, scopeOf(row))

/** The list filter of the projects the actor reads (threads.read over company and outside company; office-only ones by company). */
export const readableWhere = (actor: Actor): Prisma.ProjectWhereInput =>
  scopeWhere(actor, THREADS_READ, { company: 'companyId', party: { field: 'partyId', nullable: true } }) as Prisma.ProjectWhereInput

/** The project's row, or 404. */
export async function projectOr404(db: Reader, projectId: string): Promise<ProjectRow> {
  const row = isUuid(projectId) ? await db.project.findUnique({ where: { id: projectId }, select: PROJECT_COLUMNS }) : null
  if (!row) throw new NotFoundError('Project not found.')
  return row
}

/** The project as the office caller reads it, or 404 (also when the caller may not read it: never "you may not"). */
export async function readableProject(caller: CommandCaller, projectId: string): Promise<{ context: OfficeContext; actor: Actor; row: ProjectRow }> {
  const context = officeOf(caller)
  const actor = actorOf(context)
  const row = await caller.withClient((db) => projectOr404(db, projectId))
  if (!mayRead(actor, row)) throw new NotFoundError('Project not found.')
  return { context, actor, row }
}

/** The project the caller keeps (projects.manage over it), or 404 / 403. */
export async function managedProject(caller: CommandCaller, projectId: string): Promise<{ context: OfficeContext; actor: Actor; row: ProjectRow }> {
  const found = await readableProject(caller, projectId)
  if (!mayManage(found.actor, found.row)) throw new ForbiddenError('Your role does not keep projects for this company.')
  return found
}

/** The 409 of a refusal: its English words, the code at `refusal/<CODE>` (the screen says the Italian from the same list). */
export function refuse(code: ProjectRefusalCode, path = `refusal/${code}`): never {
  const words = PROJECT_REFUSALS[code].en
  throw new DomainError('conflict', words, [{ path, message: words }])
}

/** A 400 on one field, in words. */
export function badBody(path: string, message: string): never {
  throw new ValidationError(message, [{ path: `body/${path}`, message }])
}

/** A CLOSED project changes nothing but its reopening: 409 in words. */
export function assertOpen(status: ProjectStatus | string): void {
  if (status === 'CLOSED') refuse('CLOSED')
}

/**
 * The database's last word in words: a guard's refusal (`projects: …`, `followers: …`, `threads: …`, SQLSTATE 23514) is a 409
 * with its words; a unique key (a link twice, a number taken) a 409 to read again. Anything else goes on.
 */
export function databaseRefusal(error: unknown): never {
  const cause = error as { code?: unknown; meta?: { driverAdapterError?: { cause?: { originalCode?: unknown; originalMessage?: unknown } } } } | null
  const original = cause?.meta?.driverAdapterError?.cause
  if (original?.originalCode === '23514' && typeof original.originalMessage === 'string') {
    const match = /^(projects|followers|threads): (.*)$/s.exec(original.originalMessage)
    if (match) {
      const words = match[2]!
      throw new ConflictError(`${words.charAt(0).toUpperCase()}${words.slice(1)}.`)
    }
  }
  if (cause?.code === 'P2002' || original?.originalCode === '23505') throw new ConflictError('Someone changed this project at the same time: load it again.')
  throw error
}

/** Names of office people by id (one read). */
export async function namesOf(db: Reader, ids: readonly (string | null | undefined)[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((id): id is string => typeof id === 'string'))]
  if (wanted.length === 0) return new Map()
  return new Map((await db.user.findMany({ where: { id: { in: wanted } }, select: { id: true, displayName: true } })).map((user) => [user.id, user.displayName]))
}

/** The calendar day of a stored date (YYYY-MM-DD). */
export const dayOf = (value: Date): string => value.toISOString().slice(0, 10)
/** A business date as a stored date. */
export const asDay = (value: string): Date => new Date(`${value}T00:00:00.000Z`)
