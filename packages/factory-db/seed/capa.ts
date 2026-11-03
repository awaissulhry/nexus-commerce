import { createHash } from 'node:crypto'
import {
  AlertChannel,
  CapaActionKind,
  CapaActionStatus,
  CapaPriority,
  CapaStatus,
  CapaType,
  CauseProcess,
  GeneratedDocumentKind,
  NcrConcessionStatus,
  NcrCostKind,
  NcrCostSource,
  QualityAlertAudience,
  QualityAlertEvent,
} from '../src/generated/prisma/enums'
import { seedUuid, type SeedContext } from '../src/seeding'
import { seed as seedAuth } from './auth'
import { seed as seedHolds } from './holds'
import { seed as seedQuality } from './quality'
import { seed as seedQualityLab } from './quality-lab'
import { seed as seedReturns } from './returns'
import { seed as seedRoles } from './roles'

/**
 * The quality problems seed (W2b schema wave 11/16, B-W2b-79), per tenant of seed/_core.ts, written in the tenant's office
 * scope as the app does. The CLI runs this file early (name order); it runs the seeds it builds on first (idempotent).
 *
 *   causes       the eight processes of the cause list, one code each, with their words in Italian, English and Romanian.
 *   CAPA         SEED-CAPA-0001 at PLAN, from SEED-NCR-0002 (which names it): one corrective and one preventive action, open,
 *                the second reminded once.
 *   8D           SEED-8D-0001 at D3, for the brand P1, from SEED-CMP-0001 and SEED-NCR-0001 (a source; that NCR does not name
 *                it), with its first report: a document with no site, as the record has none.
 *   NCR cost     SEED-NCR-0002: a typed material line and a computed scrap line, from its decision.
 *   concession   P1 asked to accept SEED-NCR-0002's deviation (no answer yet), and SEED-NCR-0001's accepted, with the file.
 *   causes used  SEED-NCR-0002 and the open inspection's defect name their cause.
 *   hold group   SEED-LOT-LEA-01's genealogy hold, which took the seeded hold of SEED-HIDE-0002.
 *   settings     the tenant-wide quality settings say what the defaults say (finish the sample, 10 seconds).
 *   alert rules  the design's rules, tenant-wide, for the seeded roles, and the overdue action's escalation.
 *   complaint    SEED-CMP-0001 has its findings and a letter being written: nothing sent.
 *
 * The generated isolation tests (src/isolation.pg.vitest.test.ts) copy the FIRST row of each table by id and insert the copy:
 * a CAPA starts at its first stage, its rows are written while it is open, an action starts OPEN, a concession ASKED. So
 * SEED-CAPA-0001, its source and first action, the ASKED concession and the typed cost line get ids that start with eight
 * zeros, and the files and the document this seed adds to other modules' tables ids that start with eight f's (all still
 * derived from the namespace), so those tables' first rows stay the ones their seeds chose. SEED-NCR-0001 stays the
 * first NCR and names no CAPA: a copy of an NCR has no source row. Numbers are made-up SEED- numbers, not numbers of the
 * company's CAPA series, which stay for the app. Every name, number and value is invented. Idempotent: written once,
 * skipped when SEED-CAPA-0001 exists.
 */

const T = {
  opened: new Date('2026-11-23T08:00:00.000Z'),
  reminded: new Date('2026-11-24T08:00:00.000Z'),
  asked: new Date('2026-11-24T09:00:00.000Z'),
  answered: new Date('2026-11-25T09:00:00.000Z'),
  placed: new Date('2026-11-23T10:00:00.000Z'),
}

const day = (value: string): Date => new Date(`${value}T00:00:00.000Z`)

/** The list of the design's section df-causes: one code per process. */
const CAUSES: readonly (readonly [code: string, process: CauseProcess, labelIt: string, labelEn: string, labelRo: string])[] = [
  ['MAT-FAULT', CauseProcess.MATERIAL, 'Difetto del materiale', 'Material fault', 'Defect de material'],
  ['SUP-SPEC', CauseProcess.SUPPLIER, 'Fornitore fuori specifica', 'Supplier out of specification', 'Furnizor în afara specificației'],
  ['CUT-ERROR', CauseProcess.CUTTING, 'Errore di taglio', 'Cutting error', 'Eroare de croire'],
  ['SEW-ERROR', CauseProcess.SEWING, 'Errore di cucitura', 'Sewing error', 'Eroare de coasere'],
  ['FIN-ERROR', CauseProcess.FINISHING, 'Errore di finitura', 'Finishing error', 'Eroare de finisare'],
  ['HANDLING', CauseProcess.HANDLING, 'Danno da movimentazione', 'Handling damage', 'Deteriorare la manipulare'],
  ['DESIGN', CauseProcess.DESIGN, 'Errore di progetto', 'Design error', 'Eroare de proiectare'],
  ['MEASURE', CauseProcess.MEASUREMENT, 'Errore di misura', 'Measurement error', 'Eroare de măsurare'],
]

export interface CapaSeed {
  readonly causeCodeIds: Readonly<Record<string, string>>
  /** SEED-CAPA-0001 (PLAN) and SEED-8D-0001 (D3). */
  readonly capaId: string
  readonly eightDId: string
  /** The rows the isolation tests copy. */
  readonly sourceId: string
  readonly actionIds: readonly [string, string]
  readonly costLineId: string
  /** The ASKED concession and the ACCEPTED one. */
  readonly concessionId: string
  readonly answeredConcessionId: string
  readonly holdGroupId: string
  /** The 8D's report: a document with no site. */
  readonly reportDocumentId: string
  readonly complaintId: string
  /** SEED-NCR-0002 (it names the CAPA) and SEED-NCR-0001. */
  readonly ncrId: string
  readonly openNcrId: string
  readonly holdId: string
  /** A defect of the OPEN final inspection, which names its cause. */
  readonly openDefectId: string
  /** The PASSED final inspection and the OPEN one, with their inspector. */
  readonly passedInspectionId: string
  readonly openInspectionId: string
  readonly inspectorId: string
  readonly companyId: string
  readonly siteId: string
  readonly customerId: string
  readonly roleId: string
}

export async function seed(context: SeedContext): Promise<CapaSeed> {
  const { db, namespace } = context
  const holds = await seedHolds(context)
  const returns = await seedReturns(context)
  const quality = await seedQuality(context)
  await seedQualityLab(context)
  await seedAuth(context)
  const { roleIds } = await seedRoles(context)
  const id = (key: string): string => seedUuid(namespace, key)
  const firstId = (key: string): string => `00000000${id(key).slice(8)}`
  const lastId = (key: string): string => `ffffffff${id(key).slice(8)}`
  const tenantId = id('tenant')
  const actorId = id('actor')
  const companyA = id('company:A')
  const siteA = id('site:A1')
  const customerId = id('party:P1')
  const qualityId = id('capa:user:quality')
  const lotId = id('inventory:lot:LEA-01')
  const roleId = roleIds['quality_inspector'] as string
  const stamp = (at: Date) => ({ createdAt: at, updatedAt: at, createdById: actorId })
  const sha = (key: string): string => createHash('sha256').update(`seed capa ${key} (${namespace})`).digest('hex')
  const fileRow = (fileId: string, recordType: string, recordId: string, originalName: string, key: string, at: Date) => ({
    id: fileId,
    companyId: companyA,
    recordType,
    recordId,
    kind: 'DOCUMENT' as const,
    originalName,
    contentType: 'application/pdf',
    sizeBytes: 2048,
    sha256: sha(key),
    storeAccountId: id('files:account:r2'),
    storageKey: `t/${tenantId}/c/${companyA}/2026/${id(`capa:file:${key}:key`)}`,
    status: 'AVAILABLE' as const,
    availableAt: at,
    visibility: ['OFFICE' as const],
    ...stamp(at),
  })

  const causeCodeIds = Object.fromEntries(CAUSES.map(([code]) => [code, id(`capa:cause:${code}`)]))
  const capaId = firstId('capa:capa:0001')
  const eightDId = id('capa:capa:8D-0001')
  const sourceId = firstId('capa:source:NCR-0002')
  const actionIds = [firstId('capa:action:1'), id('capa:action:2')] as const
  const costLineId = firstId('capa:cost:1')
  const concessionId = firstId('capa:concession:NCR-0002')
  const answeredConcessionId = id('capa:concession:NCR-0001')
  const holdGroupId = id('capa:hold-group:LEA-01')
  const reportDocumentId = lastId('capa:document:8D-0001:1')
  const answerFileId = lastId('capa:file:concession')
  const reportFileId = lastId('capa:file:8d')
  const result: CapaSeed = {
    causeCodeIds,
    capaId,
    eightDId,
    sourceId,
    actionIds,
    costLineId,
    concessionId,
    answeredConcessionId,
    holdGroupId,
    reportDocumentId,
    complaintId: returns.complaintId,
    ncrId: holds.ncrId,
    openNcrId: holds.openNcrId,
    holdId: holds.holdId,
    openDefectId: quality.openDefectId,
    passedInspectionId: quality.passedInspectionId,
    openInspectionId: quality.openInspectionId,
    inspectorId: quality.inspectorId,
    companyId: companyA,
    siteId: siteA,
    customerId,
    roleId,
  }

  await db.withScope({ audience: 'office', tenantId, actorId }, (client) =>
    client.$transaction(async (tx) => {
      if (await tx.capa.findUnique({ where: { id: capaId }, select: { id: true } })) return
      const select = { id: true }
      await tx.causeCode.createMany({
        data: CAUSES.map(([code, process, labelIt, labelEn, labelRo], index) => ({
          id: id(`capa:cause:${code}`),
          code,
          process,
          labelIt,
          labelEn,
          labelI18n: { ro: labelRo },
          sortOrder: index * 10,
          ...stamp(T.opened),
        })),
      })

      await tx.capa.createMany({
        data: [
          {
            id: capaId,
            companyId: companyA,
            number: 'SEED-CAPA-0001',
            type: CapaType.CAPA,
            title: 'Grain cracks found at the cutting table',
            ownerId: actorId,
            team: [
              { userId: actorId, role: 'Lead' },
              { userId: qualityId, role: 'Quality' },
            ],
            dueOn: day('2026-12-18'),
            priority: CapaPriority.HIGH,
            problemWhat: 'A grain crack across the butt of a hide',
            problemWhere: 'Cutting table, plant A1',
            problemWhen: 'At laying, third week of November',
            problemHowMany: 'One hide of the lot so far',
            status: CapaStatus.PLAN,
            ...stamp(T.opened),
          },
          {
            id: eightDId,
            companyId: companyA,
            number: 'SEED-8D-0001',
            type: CapaType.EIGHT_D,
            title: 'Protector pocket seam opened in use',
            ownerId: actorId,
            team: [{ userId: actorId, role: 'Champion' }],
            dueOn: day('2026-12-30'),
            customerId,
            problemWhat: 'The elbow protector pocket seam opened',
            status: CapaStatus.D1,
            ...stamp(T.opened),
          },
        ],
      })
      await tx.capaSource.createMany({
        data: [
          { id: sourceId, capaId, recordType: 'Nonconformance', recordId: holds.ncrId, note: 'Repeat defect', createdAt: T.opened, createdById: actorId },
          { id: id('capa:source:CMP-0001'), capaId: eightDId, recordType: 'Complaint', recordId: returns.complaintId, note: 'Customer complaint', createdAt: T.opened, createdById: actorId },
          { id: id('capa:source:NCR-0001'), capaId: eightDId, recordType: 'Nonconformance', recordId: holds.openNcrId, createdAt: T.opened, createdById: actorId },
        ],
      })
      await tx.capaAction.createMany({
        data: [
          {
            id: actionIds[0],
            capaId,
            seq: 1,
            kind: CapaActionKind.CORRECTIVE,
            description: 'Check every hide of the lot under the light table before laying',
            ownerId: actorId,
            dueOn: day('2026-12-04'),
            status: CapaActionStatus.OPEN,
            ...stamp(T.opened),
          },
          {
            id: actionIds[1],
            capaId,
            seq: 2,
            kind: CapaActionKind.PREVENTIVE,
            description: 'Add a grain check to the incoming plan for leather',
            ownerId: qualityId,
            dueOn: day('2026-12-11'),
            status: CapaActionStatus.OPEN,
            ...stamp(T.opened),
          },
        ],
      })
      await tx.capaAction.update({ where: { id: actionIds[1] }, data: { remindersSent: 1, lastRemindedAt: T.reminded, version: 2, updatedAt: T.reminded }, select })
      await tx.capa.update({ where: { id: eightDId }, data: { status: CapaStatus.D3, version: 2, updatedAt: T.reminded }, select })
      await tx.nonconformance.update({
        where: { id: holds.ncrId },
        data: { capaId, causeCodeId: id('capa:cause:MAT-FAULT'), version: { increment: 1 }, updatedAt: T.opened },
        select,
      })

      await tx.inspectionDefect.update({ where: { id: quality.openDefectId }, data: { causeCodeId: id('capa:cause:SEW-ERROR'), version: { increment: 1 }, updatedAt: T.opened }, select })

      await tx.storedFile.create({ data: fileRow(reportFileId, 'Capa', eightDId, 'SEED-8D-0001.pdf', '8d', T.reminded), select })
      await tx.generatedDocument.create({
        data: {
          id: reportDocumentId,
          companyId: companyA,
          siteId: null,
          recordType: 'Capa',
          recordId: eightDId,
          kind: GeneratedDocumentKind.EIGHT_D,
          version: 1,
          fingerprint: sha('8d-contents'),
          language: 'it',
          number: 'SEED-8D-0001',
          fileId: reportFileId,
          createdAt: T.reminded,
          createdById: actorId,
        },
        select,
      })

      await tx.ncrCostLine.createMany({
        data: [
          { id: costLineId, siteId: siteA, ncrId: holds.ncrId, seq: 1, kind: NcrCostKind.MATERIAL, description: 'Replacement hide', amount: 18_500, ...stamp(T.opened) },
          {
            id: id('capa:cost:2'),
            siteId: siteA,
            ncrId: holds.ncrId,
            seq: 2,
            kind: NcrCostKind.SCRAP_VALUE,
            source: NcrCostSource.COMPUTED,
            amount: 4_200,
            recordType: 'NcrDispositionLine',
            recordId: holds.dispositionLineId,
            ...stamp(T.opened),
          },
        ],
      })
      await tx.ncrConcession.createMany({
        data: [
          {
            id: concessionId,
            siteId: siteA,
            ncrId: holds.ncrId,
            seq: 1,
            partyId: customerId,
            ask: 'Accept the sleeves cut from the area next to the crack',
            proposal: 'Inspect those sleeves piece by piece, at no charge',
            askedAt: T.asked,
            askedById: actorId,
            ...stamp(T.asked),
          },
          {
            id: answeredConcessionId,
            siteId: siteA,
            ncrId: holds.openNcrId,
            seq: 1,
            partyId: customerId,
            ask: 'Accept one jacket with a repaired sleeve stitch',
            proposal: 'A 5 % reduction on the jacket',
            askedAt: T.asked,
            askedById: actorId,
            ...stamp(T.asked),
          },
        ],
      })
      await tx.storedFile.create({ data: fileRow(answerFileId, 'NcrConcession', answeredConcessionId, 'Seed customer answer.pdf', 'concession', T.answered), select })
      await tx.ncrConcession.update({
        where: { id: answeredConcessionId },
        data: {
          status: NcrConcessionStatus.ACCEPTED,
          answer: 'Accepted for this order only',
          answeredAt: T.answered,
          answeredBy: 'Seed Buyer One',
          answerFileId,
          recordedById: actorId,
          version: 2,
          updatedAt: T.answered,
        },
        select,
      })

      await tx.qualityHoldGroup.create({
        data: {
          id: holdGroupId,
          companyId: companyA,
          sourceType: 'Lot',
          sourceId: lotId,
          reasonCode: 'QUALITY_CHECK',
          reasonNote: 'Grain cracks in the lot.',
          counts: { Hide: 1, shippedGarments: 0, customers: 0 },
          placedAt: T.placed,
          placedById: actorId,
          ...stamp(T.placed),
        },
        select,
      })
      await tx.qualityHold.update({ where: { id: holds.holdId }, data: { groupId: holdGroupId, version: { increment: 1 }, updatedAt: T.placed }, select })

      await tx.qualitySettings.update({ where: { id: tenantId }, data: { stopAtRejectNumber: false, benchUndoSeconds: 10, version: { increment: 1 }, updatedAt: T.opened }, select })

      const rule = (key: string, event: QualityAlertEvent, audience: QualityAlertAudience, extra: object = {}) => ({ id: id(`capa:alert-rule:${key}`), event, audience, ...extra, ...stamp(T.opened) })
      await tx.qualityAlertRule.createMany({
        data: [
          rule('hold', QualityAlertEvent.HOLD_PLACED, QualityAlertAudience.OWNER),
          rule('ncr', QualityAlertEvent.CRITICAL_NCR, QualityAlertAudience.ROLE, { roleId }),
          rule('safety', QualityAlertEvent.SAFETY_COMPLAINT, QualityAlertAudience.OWNER_AND_ROLE, { roleId, channels: [AlertChannel.IN_APP, AlertChannel.EMAIL] }),
          rule('inspection', QualityAlertEvent.INSPECTION_WAITING, QualityAlertAudience.ROLE, { roleId, withinMinutes: 240 }),
          rule('certificate', QualityAlertEvent.CERTIFICATE_EXPIRING, QualityAlertAudience.ROLE, { roleId, daysBefore: [180, 90, 30] }),
          rule('release', QualityAlertEvent.RELEASE_WAITING_SECOND_PERSON, QualityAlertAudience.ROLE, { roleId, withinMinutes: 60 }),
          rule('action', QualityAlertEvent.CAPA_ACTION_OVERDUE, QualityAlertAudience.OWNER_AND_ROLE, { roleId, withinMinutes: 1440 }),
        ],
      })

      await tx.complaint.update({
        where: { id: returns.complaintId },
        data: {
          findings: 'The pocket seam was sewn with the wrong thread on two jackets of the batch.',
          rootCause: 'A thread cone from another style was left at the station.',
          answerTemplate: 'complaint-answer',
          answerLanguage: 'it',
          answerText: 'Gentile cliente, abbiamo verificato il capo reso.',
          version: { increment: 1 },
          updatedAt: T.opened,
        },
        select,
      })
    }),
  )
  return result
}
