import type { CommandTools } from '../../core/command'

/**
 * B-TH-092: a draft's key and its removal when what was typed is sent — kept apart from ./drafts.ts (which reads records and
 * sessions) so every send path can clear its sender's draft without importing the draft routes' world.
 */

/** `draft:<recordType>:<recordId>:<userId>`, or `draft:new-request:<userId>` (the portal's New order): one per person and record. */
export const draftKeyOf = (userId: string, record: { readonly type: string; readonly id: string } | null): string => (record ? `draft:${record.type}:${record.id}:${userId}` : `draft:new-request:${userId}`)

/**
 * Inside a send's own command: the sender's draft of that record (the New order: `record` null) is removed — what was typed has gone
 * out. Nothing else is touched (another person's draft of the same record stays theirs). No row: nothing happens, nothing audited.
 */
export async function clearDraftInCommand(tools: Pick<CommandTools, 'tx' | 'audit'>, userId: string, record: { readonly type: string; readonly id: string } | null): Promise<void> {
  const row = await tools.tx.composerDraft.findFirst({ where: { key: draftKeyOf(userId, record), userId }, select: { id: true } })
  if (!row) return
  await tools.tx.composerDraft.deleteMany({ where: { id: row.id, userId } })
  tools.audit({ action: 'threads.draftSent', recordType: 'ComposerDraft', recordId: row.id, before: { recordType: record?.type ?? null, recordId: record?.id ?? null } })
}
