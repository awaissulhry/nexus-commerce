import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { ConflictError, ForbiddenError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { holds } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { VIEWS_EXPORT, VIEWS_MANAGE, VIEWS_SAVE } from '@nexus/factory-domain/views/permissions'
import { changeRefusal, menuOrder, roleDefaultFor, sharingProblems, viewSeenBy, type ViewAudience, type ViewReader, type ViewSharing } from '@nexus/factory-domain/views/rules'
import { normaliseState, VIEW_LIMITS, viewStateSchema, type ViewState } from '@nexus/factory-domain/views/state'
import { command, type CommandCaller, type CommandTx } from '../../core/command'
import { actorOf, type OfficeContext } from '../../core/context'
import { ApiError } from '../../core/errors'
import { serverClock } from '../../core/time'
import { heldRoles } from '../auth/roles/access'
import { exportFormatsFor } from '../exports/registry'
import type { CreateViewBody, SavedViewView, UpdateViewBody } from './contract'

/**
 * Saved views (B-W2a-23; PLT-163; design shell.lists toolbar "Columns ▾", pop:save-view). The rules are factory-domain
 * views/rules (who sees, who shares, who changes) and views/state (what a view keeps); this module reads the person's
 * live office roles (a view shared with a role reaches its holders now, not the holders when it was saved) and writes
 * through command(): views.create, views.update, views.remove, each audited (the name, the sharing and the list terms;
 * a view never holds a value of the list). A role keeps ONE default view per list: making another view its default
 * takes the mark off the old one in the same command (the database's partial unique index holds the rule anyway).
 * Views are tenant-wide (companyId null: the list is the same in every company the reader works in).
 */

type Client = FactoryClient | CommandTx

const VIEW = {
  id: true,
  listKey: true,
  name: true,
  ownerId: true,
  audience: true,
  roleId: true,
  roleDefault: true,
  companyId: true,
  state: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  owner: { select: { displayName: true } },
  role: { select: { name: true } },
} as const satisfies Prisma.SavedViewSelect
type ViewRow = Prisma.SavedViewGetPayload<{ select: typeof VIEW }>

function officeOf(caller: CommandCaller): OfficeContext {
  const context = caller.factoryContext
  if (!context) throw new ApiError('unauthenticated')
  if (context.audience !== 'office') throw new ApiError('forbidden')
  return context
}

export interface Reader extends ViewReader {
  readonly roles: readonly { readonly id: string; readonly name: string }[]
  readonly export: boolean
}

/** The person as the view rules see them: their live office roles (in the order they were given) and their rights. */
export async function readerOf(client: Client, context: OfficeContext): Promise<Reader> {
  const held = await heldRoles(client, context.actorId, serverClock.now())
  const roleIds = [...new Set(held.map((entry) => entry.roleId))]
  const names = new Map((await client.role.findMany({ where: { id: { in: roleIds } }, select: { id: true, name: true } })).map((role) => [role.id, role.name]))
  const actor = actorOf(context)
  return {
    userId: context.actorId,
    roleIds,
    roles: roleIds.map((id) => ({ id, name: names.get(id) ?? '' })),
    save: holds(actor, VIEWS_SAVE),
    manage: holds(actor, VIEWS_MANAGE),
    export: holds(actor, VIEWS_EXPORT),
  }
}

const stateOf = (value: Prisma.JsonValue): ViewState => {
  const parsed = viewStateSchema.safeParse(value)
  return parsed.success ? parsed.data : { query: '' }
}

function viewOf(row: ViewRow, reader: ViewReader): SavedViewView {
  return {
    id: row.id,
    listKey: row.listKey,
    name: row.name,
    ownerId: row.ownerId,
    ownerName: row.owner.displayName,
    mine: row.ownerId === reader.userId,
    audience: row.audience as ViewAudience,
    roleId: row.roleId,
    roleName: row.role?.name ?? null,
    roleDefault: row.roleDefault,
    companyId: row.companyId,
    state: stateOf(row.state),
    changeHeld: changeRefusal({ ownerId: row.ownerId, audience: row.audience as ViewAudience, roleId: row.roleId, roleDefault: row.roleDefault }, reader),
    version: row.version,
    createdAt: toUtcIso(row.createdAt),
    updatedAt: toUtcIso(row.updatedAt),
  }
}

/** The views of a list the reader may see: their own, everyone's, their roles'; tenant-wide or of the screen's company. */
function visibleWhere(listKey: string, reader: ViewReader, companyId: string | undefined): Prisma.SavedViewWhereInput {
  return {
    listKey,
    AND: [
      { OR: [{ ownerId: reader.userId }, { audience: 'EVERYONE' }, { audience: 'ROLE', roleId: { in: [...reader.roleIds] } }] },
      { OR: [{ companyId: null }, ...(companyId ? [{ companyId }] : [])] },
    ],
  }
}

/** GET /views?listKey=: the reader's menu of one list, the view it opens on, the roles they may share with, the list's export. */
export async function listViews(caller: CommandCaller, listKey: string) {
  const context = officeOf(caller)
  return caller.withClient(async (client) => {
    const reader = await readerOf(client, context)
    const rows = await client.savedView.findMany({ where: visibleWhere(listKey, reader, context.companyId), select: VIEW, take: 500 })
    const facts = rows.map((row) => ({ ...row, audience: row.audience as ViewAudience }))
    const ordered = menuOrder(facts, reader)
    const allRoles = reader.manage ? await client.role.findMany({ where: { audience: 'OFFICE' }, select: { id: true, name: true }, orderBy: [{ name: 'asc' }], take: 200 }) : []
    const formats = reader.export ? exportFormatsFor(listKey) : null
    return {
      views: ordered.map((row) => viewOf(row, reader)),
      roleDefaultId: roleDefaultFor(facts, reader)?.id ?? null,
      roles: [...reader.roles],
      allRoles,
      can: { save: reader.save, manage: reader.manage, export: reader.export },
      exports: formats && formats.length > 0 ? { formats } : null,
    }
  })
}

/** A view the reader sees (else one 404, whoever's it is). */
async function readVisible(client: Client, viewId: string, reader: ViewReader): Promise<ViewRow> {
  const row = await client.savedView.findUnique({ where: { id: viewId }, select: VIEW })
  if (!row || !viewSeenBy({ ownerId: row.ownerId, audience: row.audience as ViewAudience, roleId: row.roleId, roleDefault: row.roleDefault }, reader)) throw new NotFoundError('View not found.')
  return row
}

/** GET /views/:id (a shared link `?savedView=<id>`). */
export async function getView(caller: CommandCaller, viewId: string): Promise<{ view: SavedViewView }> {
  const context = officeOf(caller)
  return caller.withClient(async (client) => {
    const reader = await readerOf(client, context)
    return { view: viewOf(await readVisible(client, viewId, reader), reader) }
  })
}

const isUniqueViolation = (error: unknown): boolean => (error as { code?: unknown } | null)?.code === 'P2002'
const audited = (row: { listKey: string; name: string; audience: string; roleId: string | null; roleDefault: boolean; state: Prisma.JsonValue }) => ({
  listKey: row.listKey,
  name: row.name,
  audience: row.audience,
  roleId: row.roleId,
  roleDefault: row.roleDefault,
  query: stateOf(row.state).query,
})

function refuse(message: string, problems: readonly Issue[]): never {
  throw new ValidationError(message, [...problems])
}

/** The sharing asked: checked against the reader's rights, the role an office role of the tenant. */
async function checkSharing(client: Client, sharing: ViewSharing, reader: ViewReader): Promise<void> {
  const problems = sharingProblems(sharing, reader)
  if (problems.length > 0) refuse(problems[0]!.message, problems)
  if (sharing.roleId) {
    const role = await client.role.findUnique({ where: { id: sharing.roleId }, select: { audience: true } })
    if (!role || role.audience !== 'OFFICE') refuse('The role was not found.', [{ path: 'body/roleId', message: 'Not an office role of this tenant.' }])
  }
}

/** The role's one default view of the list: another view that had the mark loses it (it stays shared with the role). */
async function takeDefault(tools: { tx: CommandTx; audit: (entry: { action?: string; recordType: string; recordId: string; before?: unknown; after?: unknown; companyId?: string | null }) => void }, listKey: string, roleId: string, keep: string): Promise<void> {
  const old = await tools.tx.savedView.findFirst({ where: { listKey, roleId, roleDefault: true, companyId: null, id: { not: keep } }, select: { id: true, name: true } })
  if (!old) return
  await tools.tx.savedView.update({ where: { id: old.id }, data: { roleDefault: false, version: { increment: 1 } }, select: { id: true } })
  tools.audit({ action: 'views.update', recordType: 'SavedView', recordId: old.id, companyId: null, before: { roleDefault: true }, after: { roleDefault: false, name: old.name } })
}

async function nameTaken(client: Client, ownerId: string, listKey: string, name: string, except?: string): Promise<boolean> {
  return (await client.savedView.findFirst({ where: { ownerId, listKey, name: { equals: name, mode: 'insensitive' }, ...(except ? { id: { not: except } } : {}) }, select: { id: true } })) !== null
}

/** views.create: a new view of a list, the reader's own; shared as they chose. */
export async function createView(caller: CommandCaller, body: CreateViewBody, idempotencyKey?: string): Promise<SavedViewView> {
  const context = officeOf(caller)
  const reader = await caller.withClient((client) => readerOf(client, context))
  const sharing: ViewSharing = { audience: body.audience ?? 'ONLY_ME', roleId: body.roleId ?? null, roleDefault: body.roleDefault ?? false }
  await caller.withClient((client) => checkSharing(client, sharing, reader))
  const state = normaliseState(body.state)
  try {
    const { result } = await command(caller, { name: 'views.create', idempotencyKey, input: body }, async (tools) => {
      const { tx, now } = tools
      // Inside the work: a repeated Idempotency-Key gets its stored answer before these checks.
      const count = await tx.savedView.count({ where: { ownerId: reader.userId, listKey: body.listKey } })
      if (count >= VIEW_LIMITS.perList) throw new ConflictError(`You keep ${VIEW_LIMITS.perList} views of this list already: remove one first.`)
      if (await nameTaken(tx, reader.userId, body.listKey, body.name)) throw new ConflictError(`You already have a view named “${body.name}” on this list.`)
      const id = newId()
      if (sharing.roleDefault && sharing.roleId) await takeDefault(tools, body.listKey, sharing.roleId, id)
      const row = await tx.savedView.create({
        data: { id, listKey: body.listKey, name: body.name, ownerId: reader.userId, audience: sharing.audience, roleId: sharing.roleId, roleDefault: sharing.roleDefault, companyId: null, state: state as Prisma.InputJsonValue, createdAt: now, updatedAt: now, createdById: reader.userId },
        select: VIEW,
      })
      tools.audit({ recordType: 'SavedView', recordId: id, companyId: null, after: audited(row) })
      return viewOf(row, reader)
    })
    return result
  } catch (error) {
    if (isUniqueViolation(error)) throw new ConflictError(`You already have a view named “${body.name}” on this list.`)
    throw error
  }
}

/** views.update: the name, the sharing or what it keeps; the owner's (views.save) or a shared one (views.manage). */
export async function updateView(caller: CommandCaller, viewId: string, body: UpdateViewBody, idempotencyKey?: string): Promise<SavedViewView> {
  const context = officeOf(caller)
  const { reader, before } = await caller.withClient(async (client) => {
    const who = await readerOf(client, context)
    return { reader: who, before: await readVisible(client, viewId, who) }
  })
  const facts = { ownerId: before.ownerId, audience: before.audience as ViewAudience, roleId: before.roleId, roleDefault: before.roleDefault }
  const held = changeRefusal(facts, reader)
  if (held) throw new ForbiddenError(held)
  const audience = body.audience ?? facts.audience
  const sharing: ViewSharing = {
    audience,
    roleId: body.roleId !== undefined ? body.roleId : audience === 'ROLE' ? facts.roleId : null,
    roleDefault: body.roleDefault ?? (audience === 'ROLE' ? facts.roleDefault : false),
  }
  const changesSharing = sharing.audience !== facts.audience || sharing.roleId !== facts.roleId || sharing.roleDefault !== facts.roleDefault
  if (changesSharing) await caller.withClient((client) => checkSharing(client, sharing, reader))
  const state = body.state ? normaliseState(body.state) : null
  try {
    const { result } = await command(
      caller,
      { name: 'views.update', idempotencyKey, input: { viewId, ...body }, record: { type: 'SavedView', id: viewId, expectedVersion: body.version } },
      async (tools) => {
        const { tx, now } = tools
        if (body.name && (await nameTaken(tx, before.ownerId, before.listKey, body.name, viewId))) throw new ConflictError(`There is already a view named “${body.name}” on this list.`)
        if (sharing.roleDefault && sharing.roleId && !(facts.roleDefault && facts.roleId === sharing.roleId)) await takeDefault(tools, before.listKey, sharing.roleId, viewId)
        const row = await tx.savedView.update({
          where: { id: viewId },
          data: {
            ...(body.name ? { name: body.name } : {}),
            ...(changesSharing ? { audience: sharing.audience, roleId: sharing.roleId, roleDefault: sharing.roleDefault } : {}),
            ...(state ? { state: state as Prisma.InputJsonValue } : {}),
            updatedAt: now,
          },
          select: VIEW,
        })
        tools.audit({ recordType: 'SavedView', recordId: viewId, companyId: null, before: audited(before), after: audited(row) })
        return viewOf(row, reader)
      },
    )
    return result
  } catch (error) {
    if (isUniqueViolation(error)) throw new ConflictError(`There is already a view named “${body.name ?? before.name}” on this list.`)
    throw error
  }
}

/** views.remove: the owner's view (views.save) or a shared one (views.manage); gone from every menu. */
export async function removeView(caller: CommandCaller, viewId: string, version: number, idempotencyKey?: string): Promise<{ deleted: true }> {
  const context = officeOf(caller)
  const { reader, before } = await caller.withClient(async (client) => {
    const who = await readerOf(client, context)
    return { reader: who, before: await readVisible(client, viewId, who) }
  })
  const held = changeRefusal({ ownerId: before.ownerId, audience: before.audience as ViewAudience, roleId: before.roleId, roleDefault: before.roleDefault }, reader)
  if (held) throw new ForbiddenError(held)
  const { result } = await command(caller, { name: 'views.remove', idempotencyKey, input: { viewId, version }, record: { type: 'SavedView', id: viewId, expectedVersion: version } }, async (tools) => {
    await tools.tx.savedView.delete({ where: { id: viewId }, select: { id: true } })
    tools.audit({ recordType: 'SavedView', recordId: viewId, companyId: null, before: audited(before), after: null })
    return { deleted: true as const }
  })
  return result
}
