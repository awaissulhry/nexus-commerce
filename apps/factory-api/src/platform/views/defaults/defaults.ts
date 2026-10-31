import { ConflictError, ForbiddenError } from '@nexus/factory-domain/core/errors'
import { personalDefaultRefusal } from '@nexus/factory-domain/views/defaults/rules'
import type { ViewAudience } from '@nexus/factory-domain/views/rules'
import { command, type CommandCaller } from '../../../core/command'
import type { SavedViewView } from '../contract'
import { officeOf, readerOf, readVisible, VIEW, viewOf, type ViewRow } from '../views'

/**
 * My default view of a list (B-W2b-24, followup Z12:07 of B-W2a-23; PLT-163; rules factory-domain views/defaults): the
 * owner marks one of their own views of a list (SavedView.isPersonalDefault, B-W2b-03) and the list opens on it for them
 * before any role default. Two commands, each audited and version-checked on the view:
 *
 *   views.setPersonalDefault    the view marked; another view of the same owner and list that had the mark loses it in
 *                               the SAME command (its own audit row `views.clearPersonalDefault`, its version moves),
 *                               as a role's default does (platform/views takeDefault). The database's partial unique
 *                               index (SavedView_one_personal_default) holds one per owner, list and company anyway.
 *   views.clearPersonalDefault  the mark taken off: the list opens on the role default again, or as built.
 *
 * Only the owner's own view (the column is the row's, so it is the owner's mark; a view someone shared is saved as one's
 * own first). A view already marked (or not marked, for the unmark) answers as it is, nothing written.
 */

const isUniqueViolation = (error: unknown): boolean => (error as { code?: unknown } | null)?.code === 'P2002'
const facts = (row: ViewRow) => ({ ownerId: row.ownerId, audience: row.audience as ViewAudience, roleId: row.roleId, roleDefault: row.roleDefault })

export interface PersonalDefaultAnswer {
  readonly view: SavedViewView
  readonly personalDefaultId: string | null
}

/** The view, read for a mark or an unmark: one the reader sees (else 404) and owns (else 403 in words). */
async function ownView(caller: CommandCaller, viewId: string) {
  const context = officeOf(caller)
  const { reader, before } = await caller.withClient(async (client) => {
    const who = await readerOf(client, context)
    return { reader: who, before: await readVisible(client, viewId, who) }
  })
  const held = personalDefaultRefusal(facts(before), reader)
  if (held) throw new ForbiddenError(held)
  return { reader, before }
}

/** views.setPersonalDefault: this view opens the list for me; my other default of the list loses its mark. */
export async function setPersonalDefault(caller: CommandCaller, viewId: string, version: number, idempotencyKey?: string): Promise<PersonalDefaultAnswer> {
  const { reader, before } = await ownView(caller, viewId)
  if (before.isPersonalDefault && before.version === version) return { view: viewOf(before, reader), personalDefaultId: before.id }
  try {
    const { result } = await command(
      caller,
      { name: 'views.setPersonalDefault', idempotencyKey, input: { viewId, version }, record: { type: 'SavedView', id: viewId, expectedVersion: version } },
      async ({ tx, audit }) => {
        const current = await tx.savedView.findUniqueOrThrow({ where: { id: viewId }, select: VIEW })
        const old = await tx.savedView.findFirst({
          where: { ownerId: current.ownerId, listKey: current.listKey, companyId: current.companyId, isPersonalDefault: true, id: { not: viewId } },
          select: { id: true, name: true },
        })
        if (old) {
          await tx.savedView.update({ where: { id: old.id }, data: { isPersonalDefault: false, version: { increment: 1 } }, select: { id: true } })
          audit({ action: 'views.clearPersonalDefault', recordType: 'SavedView', recordId: old.id, companyId: null, before: { isPersonalDefault: true }, after: { isPersonalDefault: false, name: old.name, listKey: current.listKey, replacedBy: viewId } })
        }
        const row = current.isPersonalDefault ? current : await tx.savedView.update({ where: { id: viewId }, data: { isPersonalDefault: true }, select: VIEW })
        audit({ recordType: 'SavedView', recordId: viewId, companyId: null, before: { isPersonalDefault: current.isPersonalDefault }, after: { isPersonalDefault: true, name: row.name, listKey: row.listKey } })
        return { view: viewOf(row, reader), personalDefaultId: viewId }
      },
    )
    return result
  } catch (error) {
    if (isUniqueViolation(error)) throw new ConflictError('Your default view of this list changed meanwhile: read the list again.')
    throw error
  }
}

/** views.clearPersonalDefault: the list no longer opens on this view for me. */
export async function clearPersonalDefault(caller: CommandCaller, viewId: string, version: number, idempotencyKey?: string): Promise<PersonalDefaultAnswer> {
  const { reader, before } = await ownView(caller, viewId)
  if (!before.isPersonalDefault && before.version === version) return { view: viewOf(before, reader), personalDefaultId: null }
  const { result } = await command(
    caller,
    { name: 'views.clearPersonalDefault', idempotencyKey, input: { viewId, version }, record: { type: 'SavedView', id: viewId, expectedVersion: version } },
    async ({ tx, audit }) => {
      const current = await tx.savedView.findUniqueOrThrow({ where: { id: viewId }, select: VIEW })
      const row = current.isPersonalDefault ? await tx.savedView.update({ where: { id: viewId }, data: { isPersonalDefault: false }, select: VIEW }) : current
      audit({ recordType: 'SavedView', recordId: viewId, companyId: null, before: { isPersonalDefault: current.isPersonalDefault }, after: { isPersonalDefault: false, name: row.name, listKey: row.listKey } })
      return { view: viewOf(row, reader), personalDefaultId: null }
    },
  )
  return result
}
