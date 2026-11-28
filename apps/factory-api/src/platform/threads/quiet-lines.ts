import type { FastifyRequest } from 'fastify'
import type { Prisma } from '@nexus/factory-db'
import { newId } from '@nexus/factory-domain/core/ids'
import { ApiError } from '../../core/errors'
import { QUIET_LINE_BODY, quietArgsFit, type QuietArgs, type QuietLineKey, type QuietSide } from '@nexus/factory-domain/threads/quiet-lines'
import { command, type CommandTools } from '../../core/command'
import { systemCallerOf } from '../files/files'
import { ensureThread } from './threads'

/**
 * The quiet line's ONE writer (owb- order workflow, S1 po2.3; design § 5zi F; the rules and keys: factory-domain threads/quiet-lines).
 *
 *   writeQuietLine(tools, line)                    inside a command that runs in the OFFICE or the system scope (the partner role
 *                                                  writes no thread and no SYSTEM message): the order's thread (made when it has
 *                                                  none), ONE message — SYSTEM, shared with the customer (OUTBOUND, PARTNER, APP),
 *                                                  `eventKey` + `eventArgs` (+ `by`), its plain English body for a reader that draws
 *                                                  no event — and one audit row. Silent (null) for a DRAFT request.
 *   writeQuietLineAfter(request, tenantId, line)   for a command of the PORTAL door: the same line, right after that command, in the
 *                                                  tenant's system scope (its own small command, as the portal's openThread)
 *
 * A quiet line never rings a bell or wakes a portal tab (no `thread.message_posted`), never moves the thread's last activity, never
 * takes a conversation off the office's "waits on us" list and never counts as unread (reads.ts, waiting-list.ts skip it). Records:
 * a sales order, or its Draft or Sent order (a PortalOrderRequest). Args: ids and short values only (quietArgsFit), never words.
 */

export interface QuietLine {
  readonly record: { readonly type: 'SalesOrder' | 'PortalOrderRequest'; readonly id: string }
  readonly eventKey: QuietLineKey
  readonly eventArgs: QuietArgs
  /** Which side caused it; absent: read from `actorId`'s audience (a portal person: the customer; anyone else: the factory). */
  readonly by?: QuietSide | undefined
  readonly actorId?: string | null | undefined
}

/** In an office- or system-scope command: the quiet line, or null when it stays silent (a draft; a record shared with nobody). */
export async function writeQuietLine(tools: Pick<CommandTools, 'tx' | 'now' | 'audit'>, line: QuietLine): Promise<string | null> {
  const { tx, now } = tools
  if (!quietArgsFit(line.eventArgs)) throw new ApiError('internal_error', 'A quiet line carries ids and short values only.')
  if (line.record.type === 'PortalOrderRequest') {
    const request = await tx.portalOrderRequest.findUnique({ where: { id: line.record.id }, select: { status: true } })
    if (!request || request.status === 'DRAFT') return null
  }
  const by: QuietSide = line.by ?? (line.actorId ? ((await tx.user.findUnique({ where: { id: line.actorId }, select: { audience: true } }))?.audience === 'PARTNER' ? 'CUSTOMER' : 'FACTORY') : 'FACTORY')
  const { thread } = await ensureThread(tools, line.record, null)
  if (thread.partyId === null) return null
  const id = newId()
  await tx.message.create({
    data: {
      id,
      threadId: thread.id,
      partyId: thread.partyId,
      direction: 'OUTBOUND',
      audience: 'PARTNER',
      channel: 'APP',
      authorKind: 'SYSTEM',
      authorId: null,
      authorName: null,
      bodyText: QUIET_LINE_BODY[line.eventKey],
      bodyHtml: null,
      attachmentFileIds: [],
      at: now,
      createdAt: now,
      eventKey: line.eventKey,
      eventArgs: { ...line.eventArgs, by } as Prisma.InputJsonObject,
    },
    select: { id: true },
  })
  tools.audit({ action: 'threads.quietLine', recordType: 'Message', recordId: id, companyId: thread.companyId, siteId: thread.siteId, after: { threadId: thread.id, recordType: line.record.type, recordId: line.record.id, eventKey: line.eventKey, by } })
  return id
}

/** For a PORTAL command: the same quiet line right after it, as the tenant's system (the partner role writes no SYSTEM message). */
export async function writeQuietLineAfter(request: FastifyRequest, tenantId: string, line: QuietLine): Promise<void> {
  const system = systemCallerOf(request)(tenantId)
  // A draft stays silent: no command at all (a command always writes its audit row).
  if (line.record.type === 'PortalOrderRequest') {
    const request = await system.withClient((client) => client.portalOrderRequest.findUnique({ where: { id: line.record.id }, select: { status: true } }))
    if (!request || request.status === 'DRAFT') return
  }
  await command(system, { name: 'threads.quietLine', input: { ...line } }, async (tools) => {
    // Silent after all (the record shared with nobody): the command still says what it did not write.
    if ((await writeQuietLine(tools, line)) === null) tools.audit({ action: 'threads.quietLine', recordType: line.record.type, recordId: line.record.id, after: { eventKey: line.eventKey, silent: true } })
    return null
  })
}
