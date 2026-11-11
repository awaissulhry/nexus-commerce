import { createHash } from 'node:crypto'
import type { Prisma } from '../src/generated/prisma/client'
import { PpeTextTemplateKind } from '../src/generated/prisma/enums'
import { seedUuid, type SeedContext } from '../src/seeding'
import { seed as seedFiles } from './files'
import { seed as seedProduction } from './production'

/**
 * The PPE text approvals seed (W2b-5, schema wave 34/44, B-W2b-275; GATE-PPE-TEXTS), per tenant of seed/_core.ts, written in the
 * tenant's office scope as the app does. The CLI runs the seed files in name order; this one runs the production seed (the
 * tenant-wide jacket label SEED-LBL-JKT-02, revision 1) and the files seed (the file store) first, both idempotent.
 *
 *   company B   the Declaration of Conformity's template "annex-ix" version 1, checked in Italian and English by a made-up
 *               consultant, in force (the first row: the one a copy may repeat).
 *   company A   the user information's template "annex-ii-1.4" version 1 (Italian), and the jacket label's class warnings
 *               (SEED-LBL-JKT-02 revision 1, Italian and English): each recorded, then withdrawn with a reason.
 *
 * So company A's generated texts, and every tenant-wide generated document, stay drafts (the Owner's default: the golden flows
 * and the demo data keep GATE-PPE-TEXTS closed); company B's approval shows a yes in force. Each approval rests on its own
 * evidence file (a StoredFile of the approval; rows only: no object in any store).
 *
 * Every consultant, firm, date and reason is made up. Idempotent: written once, skipped when the first row exists.
 */

/** Fixed instants, so the seed never depends on the clock (every one before the day the wave was built). */
const T = {
  recorded: new Date('2026-11-03T09:00:00.000Z'),
  recordedLabel: new Date('2026-11-04T09:00:00.000Z'),
  withdrawn: new Date('2026-11-06T15:00:00.000Z'),
} as const

export interface PpeTextsSeed {
  readonly approvalIds: { readonly doc: string; readonly userInformation: string; readonly labelWarning: string }
  readonly fileIds: { readonly doc: string; readonly userInformation: string; readonly labelWarning: string }
  readonly labelTemplateId: string
}

export async function seed(context: SeedContext): Promise<PpeTextsSeed> {
  const { db, namespace } = context
  const production = await seedProduction(context)
  await seedFiles(context)
  const id = (key: string): string => seedUuid(namespace, key)
  const firstId = (key: string): string => `00000000${id(key).slice(8)}`
  const tenantId = id('tenant')
  const actorId = id('actor')
  const companyA = id('company:A')
  const companyB = id('company:B')
  const store = id('files:account:r2')
  const office = { audience: 'office', tenantId, actorId } as const
  const result: PpeTextsSeed = {
    approvalIds: { doc: firstId('ppe-texts:approval:B:DOC:annex-ix.1'), userInformation: id('ppe-texts:approval:A:USER_INFORMATION:annex-ii-1.4.1'), labelWarning: id('ppe-texts:approval:A:LABEL_WARNING:SEED-LBL-JKT-02.1') },
    fileIds: { doc: id('ppe-texts:file:B:DOC'), userInformation: id('ppe-texts:file:A:USER_INFORMATION'), labelWarning: id('ppe-texts:file:A:LABEL_WARNING') },
    labelTemplateId: production.labelTemplateId,
  }
  const { approvalIds: A, fileIds: F } = result

  if (await db.withScope(office, (client) => client.ppeTextApproval.findUnique({ where: { id: A.doc }, select: { id: true } }))) return result

  /** The consultant's signed check, a file of its approval (rows only: no object in any store). */
  const file = (fileId: string, approvalId: string, companyId: string, name: string, at: Date): Prisma.StoredFileCreateManyInput => ({
    id: fileId,
    companyId,
    recordType: 'PpeTextApproval',
    recordId: approvalId,
    kind: 'DOCUMENT',
    visibility: ['OFFICE'],
    originalName: name,
    contentType: 'application/pdf',
    sizeBytes: 4096,
    sha256: createHash('sha256').update(`seed file ${namespace} ppe-texts ${fileId}`).digest('hex'),
    storageKey: `t/${tenantId}/c/${companyId}/2026/${id(`ppe-texts:key:${fileId}`)}`,
    status: 'AVAILABLE',
    availableAt: at,
    storeAccountId: store,
    createdAt: at,
    updatedAt: at,
    createdById: actorId,
  })
  const stamp = (at: Date) => ({ recordedById: actorId, recordedAt: at, createdAt: at, updatedAt: at, createdById: actorId })
  const consultant = 'Seed PPE consultant, Studio Esempio Sicurezza (made-up)'

  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      await tx.storedFile.createMany({
        data: [
          file(F.doc, A.doc, companyB, 'Seed consultant check - DoC template annex-ix v1.pdf', T.recorded),
          file(F.userInformation, A.userInformation, companyA, 'Seed consultant check - user information annex-ii-1.4 v1.pdf', T.recorded),
          file(F.labelWarning, A.labelWarning, companyA, 'Seed consultant check - SEED-LBL-JKT-02 warnings.pdf', T.recordedLabel),
        ],
        skipDuplicates: true,
      })
      await tx.ppeTextApproval.createMany({
        data: [
          { id: A.doc, companyId: companyB, templateKind: PpeTextTemplateKind.DOC, templateKey: 'annex-ix', templateVersion: 1, languages: ['it', 'en'], checkedBy: consultant, evidenceFileId: F.doc, ...stamp(T.recorded) },
          { id: A.userInformation, companyId: companyA, templateKind: PpeTextTemplateKind.USER_INFORMATION, templateKey: 'annex-ii-1.4', templateVersion: 1, languages: ['it'], checkedBy: consultant, evidenceFileId: F.userInformation, ...stamp(T.recorded) },
          { id: A.labelWarning, companyId: companyA, templateKind: PpeTextTemplateKind.LABEL_WARNING, templateKey: 'SEED-LBL-JKT-02', templateVersion: 1, languages: ['it', 'en'], checkedBy: consultant, evidenceFileId: F.labelWarning, ...stamp(T.recordedLabel) },
        ],
      })
      // Withdrawn once, each with its reason (the rows stay: append-only but for the withdrawal).
      await tx.ppeTextApproval.update({
        where: { id: A.userInformation },
        data: { withdrawnAt: T.withdrawn, withdrawnById: actorId, withdrawReason: 'The consultant asked for the storage and cleaning sections to be written again (made-up).', version: { increment: 1 }, updatedAt: T.withdrawn },
        select: { id: true },
      })
      await tx.ppeTextApproval.update({
        where: { id: A.labelWarning },
        data: { withdrawnAt: T.withdrawn, withdrawnById: actorId, withdrawReason: 'The class B warning was reworded in the phrase library; the new words wait for a new check (made-up).', version: { increment: 1 }, updatedAt: T.withdrawn },
        select: { id: true },
      })
    }),
  )
  return result
}
