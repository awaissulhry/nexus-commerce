import type { Prisma } from '@nexus/factory-db'
import { ForbiddenError } from '@nexus/factory-domain/core/errors'
import { holds, scopeWhere, type Permission } from '@nexus/factory-domain/core/permissions'
import { QUALITY_INSPECTIONS_RECORD, QUALITY_INSPECTIONS_VIEW } from '@nexus/factory-domain/quality/final/permissions'
import { QUALITY_INCOMING_RECORD, QUALITY_INCOMING_VIEW } from '@nexus/factory-domain/quality/incoming/permissions'
import { QUALITY_INPROCESS_RECORD, QUALITY_INPROCESS_VIEW } from '@nexus/factory-domain/quality/inprocess/permissions'
import type { Person } from '@nexus/factory-domain/quality/queue/rules'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { inspectorOf, mayOn, signerOf, type Inspector } from '../final/access'

/**
 * Who reaches the inspector queue (B-W2b-106): the office and the site's tablets (their own site only). Each kind of record
 * is shown to whoever may view it (B-W2b-97's quality.inspections.view, B-W2b-98's quality.incoming.view, B-W2b-99's
 * quality.inprocess.view), and may be recorded by whoever holds the module's record permission over its company and site; a
 * caller with none of the three views is refused in words. The viewer is a worker (a tablet) or an office user: whose a row is
 * is said against them, never against anybody else.
 */

export interface Viewer {
  readonly context: Inspector
  readonly person: Person
  readonly views: { readonly final: boolean; readonly incoming: boolean; readonly inprocess: boolean }
}

export const PERMISSIONS: Readonly<Record<'final' | 'incoming' | 'inprocess', { readonly view: Permission; readonly record: Permission }>> = Object.freeze({
  final: { view: QUALITY_INSPECTIONS_VIEW, record: QUALITY_INSPECTIONS_RECORD },
  incoming: { view: QUALITY_INCOMING_VIEW, record: QUALITY_INCOMING_RECORD },
  inprocess: { view: QUALITY_INPROCESS_VIEW, record: QUALITY_INPROCESS_RECORD },
})

export function viewerOf(caller: Pick<CommandCaller, 'factoryContext'>): Viewer {
  const context = inspectorOf(caller)
  const actor = actorOf(context)
  const views = { final: holds(actor, QUALITY_INSPECTIONS_VIEW), incoming: holds(actor, QUALITY_INCOMING_VIEW), inprocess: holds(actor, QUALITY_INPROCESS_VIEW) }
  if (!views.final && !views.incoming && !views.inprocess) {
    throw new ForbiddenError(`The inspector queue needs ${QUALITY_INSPECTIONS_VIEW}, ${QUALITY_INCOMING_VIEW} or ${QUALITY_INPROCESS_VIEW}.`)
  }
  return { context, person: signerOf(context), views }
}

/** The rows of a table the viewer may see with the permission (a tablet: its own site), narrowed to a company or site asked. */
export function scopeOf(viewer: Viewer, permission: Permission, asked: { readonly companyId?: string | undefined; readonly siteId?: string | undefined }): Prisma.InspectionWhereInput & Prisma.IncomingInspectionWhereInput & Prisma.InProcessCheckWhereInput {
  return {
    AND: [
      scopeWhere(actorOf(viewer.context), permission, { company: 'companyId', site: 'siteId' }) as Prisma.InspectionWhereInput,
      viewer.context.audience === 'floor' ? { siteId: viewer.context.siteId } : {},
      asked.companyId ? { companyId: asked.companyId } : {},
      asked.siteId ? { siteId: asked.siteId } : {},
    ],
  } as never
}

export const may = (viewer: Viewer, permission: Permission, record: { readonly companyId: string; readonly siteId: string }): boolean => mayOn(viewer.context, permission, record)
