import { DomainError } from '@nexus/factory-domain/core/errors'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { FROZEN_PROOFS_ACTION, frozenProofs, PROOF_RECORD_TYPE, proofSendBlockers } from '@nexus/factory-domain/sales/quote-proofs/rules'
import type { SendCheck } from '@nexus/factory-domain/sales/quotes/send'
import type { CommandTools } from '../../../core/command'
import { retainFilesInCommand } from '../../../platform/files/files'
import { addYears, FISCAL_RETENTION_YEARS } from '../../../platform/files/rules'
import type { Reader } from '../quotes/store'
import { factsOf, proofFilesOf } from './store'

/**
 * The send and the proofs (B-W2b-165; SAL-199; quotes/send.ts calls both): the proofs go with the version and are frozen
 * with it.
 *
 *   proofSendChecks       what the Send dialog and the send check: a proof still uploading, being checked or refused
 *                         blocks the send (PROOF_NOT_READY, one per proof, in words).
 *   freezeProofsInCommand INSIDE the send's command, after the version is SENT (the version row is locked by that update,
 *                         so no proof changes meanwhile): the checks again, then each proof's current version shared
 *                         with the customer (portal and links of the quote's party: what the accept page lists) and kept
 *                         as long as the quote's PDF (ten years: the fiscal archive's, c.c. art. 2220); one audit row
 *                         on the version names the frozen proofs (name, SHA-256, version). Nothing to freeze: nothing
 *                         written.
 */

export async function proofSendChecks(db: Reader, versionId: string): Promise<SendCheck[]> {
  const rows = await proofFilesOf(db, [versionId])
  return proofSendBlockers(rows.map(factsOf)).map((blocker) => ({ code: 'PROOF_NOT_READY', severity: 'BLOCKS', path: `proofs/${blocker.fileId}`, message: blocker.message, lineId: null, size: null }))
}

export interface FreezeTarget {
  readonly companyId: string
  readonly partyId: string
  readonly number: string
  readonly versionId: string
  readonly revision: number
}

export async function freezeProofsInCommand(tools: Pick<CommandTools, 'tx' | 'audit' | 'now'>, target: FreezeTarget): Promise<string[]> {
  const { tx, now } = tools
  const rows = await proofFilesOf(tx, [target.versionId])
  if (rows.length === 0) return []
  const facts = rows.map(factsOf)
  const blockers = proofSendBlockers(facts)
  if (blockers.length > 0) {
    throw new DomainError('conflict', `The quote cannot be sent yet. ${blockers.map((blocker) => blocker.message).join(' ')}`, blockers.map((blocker) => ({ path: `proofs/${blocker.fileId}`, message: blocker.message })))
  }
  const frozen = frozenProofs(facts).map((fact) => fact.row)
  if (frozen.length === 0) return []
  for (const row of frozen) {
    await tx.storedFile.update({ where: { id: row.id }, data: { visibility: ['OFFICE', 'PARTNER', 'LINK'], partyId: target.partyId, floorSiteId: null, version: { increment: 1 } }, select: { id: true } })
    tools.audit({
      action: 'files.setVisibility',
      recordType: 'StoredFile',
      recordId: row.id,
      companyId: row.companyId,
      before: { visibility: row.visibility, partyId: row.partyId },
      after: { visibility: ['OFFICE', 'PARTNER', 'LINK'], partyId: target.partyId },
      reason: `Proof sent with quote ${target.number} version ${target.revision}`,
    })
  }
  const ids = frozen.map((row) => row.id)
  await retainFilesInCommand(tools, ids, addYears(now, FISCAL_RETENTION_YEARS), `Proof sent with quote ${target.number} version ${target.revision}: kept with the quote's PDF`)
  tools.audit({
    action: FROZEN_PROOFS_ACTION,
    recordType: PROOF_RECORD_TYPE,
    recordId: target.versionId,
    companyId: target.companyId,
    after: { versionId: target.versionId, revision: target.revision, at: toUtcIso(now), proofs: frozen.map((row) => ({ fileId: row.id, name: row.originalName, sha256: row.sha256, versionNo: row.versionNo, sizeBytes: row.sizeBytes, contentType: row.contentType })) },
  })
  return ids
}
