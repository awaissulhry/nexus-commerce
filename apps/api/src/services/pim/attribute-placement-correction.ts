/**
 * P3b S5 (docs/attributes/PLAN.md §10.9) — the reviewed cleanup of the shared attribute set.
 *
 * The proposal (`@nexus/shared/attribute-placement-proposal`, made from the attribute-scope study) is read against THIS
 * business's dictionary: each attribute of the proposal that the business has gets its current state, what the proposal
 * would do (keep on Shared, place on a channel, archive) and whether it can (a family that requires it on another
 * channel, or at all for an archive, blocks it — a required attribute is never hidden). The Owner approves group by
 * group, or every group ("approve the rest"). The four disputed rows are never applied by a group: they need their own
 * decision (`includeDisputed`).
 *
 * The preview carries a fingerprint of every state it read; an apply with an older fingerprint is refused. An apply is
 * one transaction built from the S3 moves (`attribute-placement.service.ts`), each audited with the batch id; undo
 * restores the whole batch, and only while every row still equals what the batch made.
 */
import { createHash, randomUUID } from 'node:crypto'
import prisma from '../../db.js'
import { inDatabaseTransaction } from '../../lib/database-context.js'
import {
  PLACEMENT_PROPOSAL, PLACEMENT_PROPOSAL_DISPUTED, PLACEMENT_PROPOSAL_GROUPS, PLACEMENT_PROPOSAL_REVISION,
  type PlacementProposalGroup,
} from '@nexus/shared/attribute-placement-proposal'
import {
  archiveAttribute, PlacementError, requirementsAfter, restoreAttribute, setAttributePlacement, undoPlacementChange,
  type Actor, type PlacementState,
} from './attribute-placement.service.js'

const CHANNEL_OF: Partial<Record<PlacementProposalGroup, string>> = { amazon: 'AMAZON', ebay: 'EBAY', shopify: 'SHOPIFY' }

export interface ProposalRow {
  code: string
  attributeId: string
  group: PlacementProposalGroup
  disputed: boolean
  sameFactAs?: string[]
  current: { placement: string; placementChannels: string[]; archived: boolean; semanticKey: string | null }
  proposed: { action: 'shared' | 'channel' | 'archive'; channels: string[] }
  status: 'change' | 'no-change' | 'blocked'
  reason?: string
}

export interface ProposalPreview {
  revision: string
  fingerprint: string
  groups: Array<{ group: PlacementProposalGroup; rows: ProposalRow[]; changes: number; blocked: number }>
  /** The four rows the study and the concept catalogue disagree on; shown first, applied only one by one. */
  disputed: ProposalRow[]
  /** Business attributes the proposal does not know (new ones, the starter set): left alone. */
  notInProposal: string[]
}

async function readRows(): Promise<ProposalRow[]> {
  const attributes = await prisma.customAttribute.findMany({
    where: { code: { in: PLACEMENT_PROPOSAL.map(r => r.code) } },
    select: { id: true, code: true, placement: true, placementChannels: true, archivedAt: true, semanticKey: true,
      familyAttributes: { where: { required: true }, select: { id: true, channels: true, family: { select: { id: true, label: true } } } } },
  })
  const byCode = new Map(attributes.map(a => [a.code, a]))
  const rows: ProposalRow[] = []
  for (const proposal of PLACEMENT_PROPOSAL) {
    const a = byCode.get(proposal.code)
    if (!a) continue
    const current = { placement: a.placement, placementChannels: a.placementChannels, archived: !!a.archivedAt, semanticKey: a.semanticKey }
    const requirements: PlacementState['requirements'] = a.familyAttributes.map(fa => ({ familyAttributeId: fa.id, familyId: fa.family.id, familyLabel: fa.family.label, channels: fa.channels }))
    const channel = CHANNEL_OF[proposal.group]
    const proposed = proposal.group === 'core' ? { action: 'shared' as const, channels: [] }
      : channel ? { action: 'channel' as const, channels: [channel] } : { action: 'archive' as const, channels: [] }
    let status: ProposalRow['status'] = 'change'
    let reason: string | undefined
    if (proposed.action === 'archive') {
      if (current.archived) status = 'no-change'
      else if (requirements.length) { status = 'blocked'; reason = `required in ${requirements.map(r => r.familyLabel).join(', ')}` }
    } else {
      const same = !current.archived && current.placement === proposed.action && JSON.stringify(current.placementChannels) === JSON.stringify(proposed.channels)
      if (same) status = 'no-change'
      else {
        const { conflicts } = requirementsAfter(requirements, { placement: proposed.action, placementChannels: proposed.channels })
        if (conflicts.length) { status = 'blocked'; reason = `required on ${conflicts.map(c => `${c.channels.join(', ')} in ${c.familyLabel}`).join('; ')}` }
      }
    }
    rows.push({ code: a.code, attributeId: a.id, group: proposal.group, disputed: PLACEMENT_PROPOSAL_DISPUTED.includes(a.code),
      ...(proposal.sameFactAs ? { sameFactAs: proposal.sameFactAs } : {}), current, proposed, status, ...(reason ? { reason } : {}) })
  }
  return rows
}

function fingerprintOf(rows: ProposalRow[]): string {
  return createHash('sha256').update(JSON.stringify([PLACEMENT_PROPOSAL_REVISION, rows.map(r => [r.attributeId, r.current, r.status])])).digest('hex')
}

export async function placementProposalPreview(): Promise<ProposalPreview> {
  const [rows, all] = await Promise.all([readRows(), prisma.customAttribute.findMany({ select: { code: true } })])
  const known = new Set(PLACEMENT_PROPOSAL.map(r => r.code))
  return {
    revision: PLACEMENT_PROPOSAL_REVISION,
    fingerprint: fingerprintOf(rows),
    disputed: rows.filter(r => r.disputed),
    groups: PLACEMENT_PROPOSAL_GROUPS.map(group => {
      const inGroup = rows.filter(r => r.group === group && !r.disputed)
      return { group, rows: inGroup, changes: inGroup.filter(r => r.status === 'change').length, blocked: inGroup.filter(r => r.status === 'blocked').length }
    }),
    notInProposal: all.map(a => a.code).filter(code => !known.has(code)).sort(),
  }
}

export interface ApplyProposalInput {
  fingerprint: string
  /** The groups approved, or `'all'` ("approve the rest"). */
  groups: PlacementProposalGroup[] | 'all'
  /** Disputed codes to apply as the study proposes (the rest of them stay as they are). */
  includeDisputed?: string[]
}

export async function applyPlacementProposal(input: ApplyProposalInput, actor: Actor = {}) {
  const groups = input.groups === 'all' ? [...PLACEMENT_PROPOSAL_GROUPS] : input.groups
  if (!Array.isArray(groups) || !groups.length || groups.some(g => !PLACEMENT_PROPOSAL_GROUPS.includes(g))) {
    throw new PlacementError(400, `groups must be 'all' or a list of: ${PLACEMENT_PROPOSAL_GROUPS.join(', ')}`)
  }
  const disputed = input.includeDisputed ?? []
  if (disputed.some(code => !PLACEMENT_PROPOSAL_DISPUTED.includes(code))) throw new PlacementError(400, `includeDisputed takes only: ${PLACEMENT_PROPOSAL_DISPUTED.join(', ')}`)
  return inDatabaseTransaction(prisma, async () => {
    const rows = await readRows()
    if (fingerprintOf(rows) !== input.fingerprint) throw new PlacementError(409, 'The dictionary changed after this preview. Load the proposal again and review it.')
    const batchId = randomUUID()
    const metadata = { proposalBatch: batchId, revision: PLACEMENT_PROPOSAL_REVISION }
    const applied: Array<{ code: string; action: string }> = []
    for (const row of rows) {
      if (row.status !== 'change') continue
      if (row.disputed ? !disputed.includes(row.code) : !groups.includes(row.group)) continue
      if (row.proposed.action === 'archive') await archiveAttribute(row.attributeId, actor, { metadata })
      else {
        if (row.current.archived) await restoreAttribute(row.attributeId, actor, { metadata })
        await setAttributePlacement(row.attributeId, { placement: row.proposed.action, channels: row.proposed.channels }, actor, { metadata })
      }
      applied.push({ code: row.code, action: row.proposed.action === 'channel' ? `channel:${row.proposed.channels.join(',')}` : row.proposed.action })
    }
    await prisma.auditLog.create({ data: { entityType: 'AttributePlacementProposal', entityId: batchId, action: 'attribute.placement.proposal.applied',
      after: { groups, includeDisputed: disputed, applied } as never, metadata: { fingerprint: input.fingerprint, revision: PLACEMENT_PROPOSAL_REVISION } as never,
      userId: actor.userId ?? null, ip: actor.ip ?? null } })
    return { batchId, applied: applied.length, changes: applied }
  })
}

/** Undo a whole batch, newest change first; refused (nothing changes) if any row changed after the batch. */
export async function undoPlacementProposal(batchId: string, actor: Actor = {}) {
  return inDatabaseTransaction(prisma, async () => {
    const rows = await prisma.auditLog.findMany({ where: { entityType: 'CustomAttribute', metadata: { path: ['proposalBatch'], equals: batchId } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] })
    if (!rows.length) throw new PlacementError(404, 'proposal batch not found')
    for (const row of rows) {
      if (row.action === 'attribute.placement') await undoPlacementChange(row.id, actor)
      else if (row.action === 'attribute.archive') {
        const attribute = await prisma.customAttribute.findUnique({ where: { id: row.entityId }, select: { archivedAt: true } })
        if (!attribute?.archivedAt) throw new PlacementError(409, 'An attribute of this batch changed after it; undo the later change first.')
        await restoreAttribute(row.entityId, actor)
      } else if (row.action === 'attribute.restore') {
        await archiveAttribute(row.entityId, actor)
      }
    }
    await prisma.auditLog.create({ data: { entityType: 'AttributePlacementProposal', entityId: batchId, action: 'attribute.placement.proposal.undone',
      userId: actor.userId ?? null, ip: actor.ip ?? null } })
    return { batchId, undone: rows.length }
  })
}
