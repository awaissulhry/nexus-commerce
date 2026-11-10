import type { Prisma } from '@nexus/factory-db'
import { LABELS_VIEW } from '@nexus/factory-domain/compliance/labels/permissions'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { LABEL_SCOPE, officeOf } from '../labels/store'
import type { ArtworkWaitingView } from './contract'

/**
 * B-W2b-270 (Labels & marking in depth) — the smallest read its list needed, added beside B-W2b-259's artwork: the DRAFT
 * proofs that wait for a second person's approval, of the labels the reader may see (W1's list scope: the certificate
 * register's view over the label's company; a label of every company for everyone who reads labels). It feeds the list's
 * tile "Artwork waiting approval" and its saved view; it reads two tables, writes nothing, names no person (only whether
 * the reader made the proof, so cannot approve it). A retired label takes no artwork: its drafts are left out.
 */

/** As many labels as W1's list reads (its own cap). */
const LIST_CAP = 500

/** GET /compliance/label-artwork/waiting */
export async function readWaitingArtwork(caller: CommandCaller): Promise<ArtworkWaitingView> {
  const context = officeOf(caller)
  const where: Prisma.LabelTemplateWhereInput = { AND: [scopeWhere(actorOf(context), LABELS_VIEW, LABEL_SCOPE) as Prisma.LabelTemplateWhereInput, { status: { not: 'RETIRED' } }] }
  return caller.withClient(async (db) => {
    const templates = await db.labelTemplate.findMany({ where, select: { id: true }, orderBy: [{ code: 'asc' }, { revision: 'asc' }], take: LIST_CAP })
    const rows =
      templates.length === 0
        ? []
        : await db.labelArtworkVersion.findMany({
            where: { status: 'DRAFT', templateId: { in: templates.map((template) => template.id) } },
            select: { id: true, templateId: true, versionNo: true, authorId: true, createdById: true, createdAt: true },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          })
    return {
      waiting: rows.map((row) => ({ templateId: row.templateId, artworkId: row.id, versionNo: row.versionNo, byYou: (row.authorId ?? row.createdById) === context.actorId, createdAt: toUtcIso(row.createdAt) })),
      asOf: businessDate(serverClock.now()),
    }
  })
}
