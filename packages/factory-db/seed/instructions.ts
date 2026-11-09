import type { Prisma } from '../src/generated/prisma/client'
import { InstructionMediaKind, InstructionVersionStatus, MasterStatus, OperationTimeSource, OperationTimeVersionStatus } from '../src/generated/prisma/enums'
import { seedUuid, type SeedContext } from '../src/seeding'
import { seed as seedFiles } from './files'
import { seed as seedInspectionPlans } from './inspection-plans'

/**
 * The routings, standard minutes and work instructions seed (W2b-4 schema wave 25/33, B-W2b-205), per tenant of
 * seed/_core.ts. Written in the tenant's office scope, the acknowledgements in plant A1's floor scope on its cutting
 * tablet, as the app does. The CLI runs this file after seed/inspection-plans.ts (name order); it runs that seed anyway
 * (idempotent: it brings the product, production, floor sign-in and inspection plan seeds) and the files seed (the
 * store the media's files are in).
 *
 *   minutes      the library's cutting operation SEED-CUT-LEA is governed: v1 APPROVED by a second person (basic 12.500,
 *                allowances 5 + 4 + 3 %, SMV 14.000, a time study) and its numbers set to v1's; v2 PROPOSED (basic
 *                12.000, SMV 13.440, a new cutting table), waiting for the second person.
 *   routing      on the product seed's DRAFT revision 1 of SEED-JKT-01: the cutting step copies v1 (with set-up and move
 *                minutes); the sewing step has the in-line plan INL-FIRST as its checkpoint, a wait, extra minutes for
 *                size 54 (+4.000) and 50 (−1.500) and its own machine setting; the library's sewing operation its default
 *                setting (post-bed, 301, 134 LR Nm 110, Tkt 40, 3.5 per cm).
 *   instructions WI SEED-WI-0001: an old one for cutting, ARCHIVED (its v1 PUBLISHED). SEED-WI-0002 for sewing on every
 *                style: v1 SUPERSEDED, v2 PUBLISHED (three steps, the seam a critical point with a safety note; a photo and
 *                a video), v3 a DRAFT (one step, one photo). SEED-WI-0003 for sewing on
 *                SEED-JKT-02 revision 1 only (the production seed's released revision): v1 PUBLISHED. Written by the
 *                seed's office user, approved by a made-up methods engineer (the author never approves).
 *   seen         A1's operator saw SEED-WI-0002 v1 and v2 on the cutting tablet (Italian); the office recorded the team
 *                leader's paper acknowledgement of SEED-WI-0003 v1. Nobody's figure: a training record.
 *
 * The generated isolation tests (src/isolation.pg.vitest.test.ts) copy the FIRST row of each table by id and insert the
 * copy: an SMV version starts PROPOSED, an instruction version DRAFT, a step and a medium only on a DRAFT version, one
 * ACTIVE instruction per operation and revision, and a floor session acknowledges on its tablet. So the PROPOSED v2, the
 * ARCHIVED instruction, the DRAFT v3 with its step and photo, the size 54 row, the step's setting and the operator's device
 * acknowledgement of v2 get ids that start with eight zeros; the files get eight f's (the files seed's first rows stay
 * first). Numbers are made-up SEED- numbers, not numbers of the company's WORK_INSTRUCTION series, which stays for the
 * app. Every name, number and value is invented. Idempotent: written once, skipped when the first instruction exists.
 */

/** Fixed instants, so the seed never depends on the clock. */
const T = {
  studied: new Date('2026-11-16T08:00:00.000Z'),
  approved: new Date('2026-11-16T10:00:00.000Z'),
  proposed: new Date('2026-11-17T08:00:00.000Z'),
  written: new Date('2026-11-18T08:00:00.000Z'),
  published: new Date('2026-11-18T09:00:00.000Z'),
  rewritten: new Date('2026-11-19T08:00:00.000Z'),
  republished: new Date('2026-11-19T09:00:00.000Z'),
  seen: new Date('2026-11-19T10:00:00.000Z'),
  drafted: new Date('2026-11-20T08:00:00.000Z'),
}

export interface InstructionsSeed {
  readonly operationIds: { readonly cut: string; readonly sew: string }
  /** SEED-CUT-LEA's SMV versions: v1 APPROVED, v2 PROPOSED. */
  readonly timeVersionIds: { readonly approved: string; readonly proposed: string }
  /** The product seed's DRAFT revision 1 of SEED-JKT-01, its cutting and sewing steps. */
  readonly draftRevisionId: string
  readonly styleId: string
  readonly routingStepIds: { readonly cut: string; readonly sew: string }
  /** The production seed's RELEASED revision 1 of SEED-JKT-02, its sewing step. */
  readonly releasedRevisionId: string
  readonly releasedStyleId: string
  readonly releasedSewStepId: string
  readonly sizeTimeIds: { readonly size54: string; readonly size50: string }
  readonly machineSettingIds: { readonly library: string; readonly step: string }
  readonly inspectionPlanId: string
  /** SEED-WI-0001 (ARCHIVED), SEED-WI-0002 (every style), SEED-WI-0003 (SEED-JKT-02 revision 1). */
  readonly instructionIds: { readonly archived: string; readonly sewing: string; readonly revision: string }
  readonly versionIds: { readonly archivedV1: string; readonly sewingV1: string; readonly sewingV2: string; readonly sewingDraft: string; readonly revisionV1: string }
  readonly stepIds: { readonly prepare: string; readonly seam: string; readonly check: string; readonly draft: string }
  readonly mediaIds: { readonly photo: string; readonly video: string; readonly draft: string }
  readonly fileIds: { readonly photo: string; readonly video: string }
  readonly ackIds: { readonly deviceV1: string; readonly deviceV2: string; readonly paper: string }
  readonly operatorId: string
  readonly leadId: string
  readonly deviceId: string
  readonly approverId: string
}

export async function seed(context: SeedContext): Promise<InstructionsSeed> {
  const { db, namespace } = context
  const plans = await seedInspectionPlans(context)
  await seedFiles(context)
  const id = (key: string): string => seedUuid(namespace, key)
  const firstId = (key: string): string => `00000000${id(key).slice(8)}`
  const lastId = (key: string): string => `ffffffff${id(key).slice(8)}`
  const tenantId = id('tenant')
  const actorId = id('actor')
  const companyA = id('company:A')
  const siteA = id('site:A1')
  const approverId = id('instructions:user:methods-engineer')
  const store = id('files:account:r2')
  const office = { audience: 'office' as const, tenantId, actorId }
  const stamp = (at: Date, by: string = actorId) => ({ createdAt: at, updatedAt: at, createdById: by })

  const operationIds = { cut: id('product:operation:CUT'), sew: id('product:operation:SEW') }
  const styleId = id('product:style:JKT-01')
  const draftRevisionId = id('product:revision:JKT-01:1')
  const routingStepIds = { cut: id('product:routing:JKT-01:1:SEED-CUT-LEA'), sew: id('product:routing:JKT-01:1:SEED-SEW-ASM') }
  const releasedRevisionId = lastId('production:revision:JKT-02:1')
  const releasedStyleId = id('production:style:JKT-02')
  const result: InstructionsSeed = {
    operationIds,
    timeVersionIds: { approved: id('instructions:smv:CUT:1'), proposed: firstId('instructions:smv:CUT:2') },
    draftRevisionId,
    styleId,
    routingStepIds,
    releasedRevisionId,
    releasedStyleId,
    releasedSewStepId: lastId('production:routing:JKT-02:1:SEED-SEW-ASM'),
    sizeTimeIds: { size54: firstId('instructions:size-time:JKT-01:1:SEW:54'), size50: id('instructions:size-time:JKT-01:1:SEW:50') },
    machineSettingIds: { library: id('instructions:setting:SEW:1'), step: firstId('instructions:setting:JKT-01:1:SEW:1') },
    inspectionPlanId: plans.planIds.inLine,
    instructionIds: { archived: firstId('instructions:wi:1'), sewing: id('instructions:wi:2'), revision: id('instructions:wi:3') },
    versionIds: {
      archivedV1: id('instructions:wi:1:v1'),
      sewingV1: id('instructions:wi:2:v1'),
      sewingV2: id('instructions:wi:2:v2'),
      sewingDraft: firstId('instructions:wi:2:v3'),
      revisionV1: id('instructions:wi:3:v1'),
    },
    stepIds: { prepare: id('instructions:wi:2:v2:PREPARE'), seam: id('instructions:wi:2:v2:SEAM'), check: id('instructions:wi:2:v2:CHECK'), draft: firstId('instructions:wi:2:v3:SEAM') },
    mediaIds: { photo: id('instructions:wi:2:v2:SEAM:photo'), video: id('instructions:wi:2:v2:SEAM:video'), draft: firstId('instructions:wi:2:v3:SEAM:photo') },
    fileIds: { photo: lastId('instructions:file:seam-photo'), video: lastId('instructions:file:seam-video') },
    ackIds: { deviceV1: id('instructions:ack:operator:wi:2:v1'), deviceV2: firstId('instructions:ack:operator:wi:2:v2'), paper: lastId('instructions:ack:lead:wi:3:v1') },
    operatorId: plans.operatorId,
    leadId: plans.inspectorId,
    deviceId: plans.deviceId,
    approverId,
  }

  const done = await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      if (await tx.workInstruction.findUnique({ where: { id: result.instructionIds.archived }, select: { id: true } })) return true

      // --- standard minutes: SEED-CUT-LEA governed by v1, v2 waiting ----------------------------------------------------
      const minutes = { basicMinutes: '12.500', personalPct: '5.0000', fatiguePct: '4.0000', delayPct: '3.0000', standardMinutes: '14.000' }
      await tx.operationTimeVersion.createMany({
        data: [
          {
            id: result.timeVersionIds.approved,
            operationId: operationIds.cut,
            number: 1,
            ...minutes,
            source: OperationTimeSource.TIME_STUDY,
            effectiveFrom: new Date('2026-11-16'),
            reason: 'Time study of the cutting table, ten hides.',
            proposedById: actorId,
            ...stamp(T.studied),
          },
          {
            id: result.timeVersionIds.proposed,
            operationId: operationIds.cut,
            number: 2,
            basicMinutes: '12.000',
            personalPct: '5.0000',
            fatiguePct: '4.0000',
            delayPct: '3.0000',
            standardMinutes: '13.440',
            source: OperationTimeSource.TIME_STUDY,
            effectiveFrom: new Date('2026-12-01'),
            reason: 'The new cutting table needs less handling.',
            proposedById: actorId,
            ...stamp(T.proposed),
          },
        ],
      })
      await tx.operationTimeVersion.update({
        where: { id: result.timeVersionIds.approved },
        data: { status: OperationTimeVersionStatus.APPROVED, decidedById: approverId, decidedAt: T.approved, decisionNote: 'Matches the study.', updatedAt: T.approved },
        select: { id: true },
      })
      await tx.operation.update({ where: { id: operationIds.cut }, data: { basicMinutes: minutes.basicMinutes, personalPct: minutes.personalPct, fatiguePct: minutes.fatiguePct, delayPct: minutes.delayPct, updatedAt: T.approved }, select: { id: true } })

      // --- the draft routing of SEED-JKT-01 revision 1 -----------------------------------------------------------------
      await tx.routingOperation.update({
        where: { id: routingStepIds.cut },
        data: { ...minutes, timeVersionId: result.timeVersionIds.approved, setupMinutes: '20.000', moveMinutes: '5.000', updatedAt: T.approved },
        select: { id: true },
      })
      await tx.routingOperation.update({ where: { id: routingStepIds.sew }, data: { inspectionPlanId: result.inspectionPlanId, waitMinutes: '15.000', updatedAt: T.approved }, select: { id: true } })
      await tx.routingOperationSizeTime.createMany({
        data: [
          { id: result.sizeTimeIds.size54, revisionId: draftRevisionId, routingOperationId: routingStepIds.sew, size: '54', extraMinutes: '4.000', ...stamp(T.approved) },
          { id: result.sizeTimeIds.size50, revisionId: draftRevisionId, routingOperationId: routingStepIds.sew, size: '50', extraMinutes: '-1.500', ...stamp(T.approved) },
        ],
      })
      const setting = { seq: 1, stitchType: '301', needle: '134 LR, Nm 110', thread: 'Tkt 40, polyester', tension: 'upper 4, lower medium', foot: 'roller foot' }
      await tx.operationMachineSetting.createMany({
        data: [
          { id: result.machineSettingIds.library, operationId: operationIds.sew, ...setting, stitchesPerCm: '3.50', ...stamp(T.approved) },
          { id: result.machineSettingIds.step, revisionId: draftRevisionId, routingOperationId: routingStepIds.sew, ...setting, stitchesPerCm: '3.00', notes: 'Longer stitch on the 1.2 mm leather.', ...stamp(T.approved) },
        ],
      })

      // --- the files of the media (rows only: the objects are not in the store) -----------------------------------------
      const file = (rowId: string, name: string, contentType: string): Prisma.StoredFileCreateManyInput => ({
        id: rowId,
        companyId: companyA,
        recordType: 'WorkInstruction',
        recordId: result.instructionIds.sewing,
        kind: 'PHOTO',
        originalName: name,
        contentType,
        sizeBytes: 4096,
        sha256: seedUuid(namespace, `instructions:sha:${name}`).replace(/-/g, '').padEnd(64, '0'),
        storageKey: `t/${tenantId}/c/${companyA}/2026/${id(`instructions:key:${name}`)}`,
        storeAccountId: store,
        status: 'AVAILABLE',
        availableAt: T.written,
        visibility: ['OFFICE', 'FLOOR'],
        floorSiteId: siteA,
        ...stamp(T.written),
      })
      await tx.storedFile.createMany({
        data: [file(result.fileIds.photo, 'Seed seam allowance.jpg', 'image/jpeg'), file(result.fileIds.video, 'Seed seam allowance.mp4', 'video/mp4')],
        skipDuplicates: true,
      })

      // --- work instructions --------------------------------------------------------------------------------------------
      await tx.workInstruction.createMany({
        data: [
          { id: result.instructionIds.archived, companyId: companyA, number: 'SEED-WI-0001', operationId: operationIds.cut, ...stamp(T.written) },
          { id: result.instructionIds.sewing, companyId: companyA, number: 'SEED-WI-0002', operationId: operationIds.sew, ...stamp(T.written) },
          { id: result.instructionIds.revision, companyId: companyA, number: 'SEED-WI-0003', operationId: operationIds.sew, styleId: releasedStyleId, styleRevisionId: releasedRevisionId, ...stamp(T.written) },
        ],
      })
      const words = (it: string, en: string) => ({ it, en })
      const step = (rowId: string, versionId: string, sortOrder: number, code: string, text: Record<string, string>, extra: Partial<Prisma.WorkInstructionStepCreateManyInput> = {}, at = T.written): Prisma.WorkInstructionStepCreateManyInput => ({
        id: rowId,
        versionId,
        sortOrder,
        code,
        textI18n: text,
        ...extra,
        ...stamp(at),
      })
      const publish = (versionId: string, at: Date) =>
        tx.workInstructionVersion.update({ where: { id: versionId }, data: { status: InstructionVersionStatus.PUBLISHED, approvedById: approverId, publishedAt: at, updatedAt: at }, select: { id: true } })

      // The first versions of the three.
      await tx.workInstructionVersion.createMany({
        data: [
          { id: result.versionIds.archivedV1, instructionId: result.instructionIds.archived, number: 1, authorId: actorId, ...stamp(T.written) },
          { id: result.versionIds.revisionV1, instructionId: result.instructionIds.revision, number: 1, authorId: actorId, ...stamp(T.written) },
          { id: result.versionIds.sewingV1, instructionId: result.instructionIds.sewing, number: 1, authorId: actorId, ...stamp(T.written) },
        ],
      })
      await tx.workInstructionStep.createMany({
        data: [
          step(id('instructions:wi:1:v1:LAY'), result.versionIds.archivedV1, 10, 'LAY_HIDE', words('Stendere la pelle con il fiore in alto.', 'Lay the hide grain side up.')),
          step(id('instructions:wi:3:v1:ZIP_GUARD'), result.versionIds.revisionV1, 10, 'ZIP_GUARD', words('Cucire la pattina del cursore prima del collo.', 'Sew the zip guard before the collar.'), { icon: 'needle' }),
          step(id('instructions:wi:2:v1:SEAM'), result.versionIds.sewingV1, 10, 'SEAM', words('Cucire il fianco a 10 mm dal bordo.', 'Sew the side seam 10 mm from the edge.'), { critical: true }),
        ],
      })
      // The old cutting instruction was published while it was active, then archived.
      await publish(result.versionIds.archivedV1, T.published)
      await tx.workInstruction.update({ where: { id: result.instructionIds.archived }, data: { status: MasterStatus.ARCHIVED, updatedAt: T.rewritten }, select: { id: true } })
      await publish(result.versionIds.revisionV1, T.published)
      await publish(result.versionIds.sewingV1, T.published)

      // SEED-WI-0002 v2: three steps with media, published in v1's place. Its steps are optional ticks (B-W2b-214: the published
      // steps are the operation's checklist, and a required one holds Finish; every seeded work order is sewn on this operation).
      await tx.workInstructionVersion.create({
        data: { id: result.versionIds.sewingV2, instructionId: result.instructionIds.sewing, number: 2, changeNote: 'Adds the seam check and its photo and video.', authorId: actorId, ...stamp(T.rewritten) },
        select: { id: true },
      })
      await tx.workInstructionStep.createMany({
        data: [
          step(result.stepIds.prepare, result.versionIds.sewingV2, 10, 'PREPARE', words('Controllare ago e filo sulla scheda della macchina.', 'Check the needle and thread against the machine sheet.'), { icon: 'needle' }, T.rewritten),
          step(
            result.stepIds.seam,
            result.versionIds.sewingV2,
            20,
            'SEAM',
            { ...words('Cucire il fianco a 10 mm dal bordo.', 'Sew the side seam 10 mm from the edge.'), ro: 'Coaseți cusătura laterală la 10 mm de margine.' },
            { critical: true, safetyNoteI18n: words('Tenere le dita lontane dal piedino.', 'Keep your fingers away from the foot.'), icon: 'ruler' },
            T.rewritten,
          ),
          step(result.stepIds.check, result.versionIds.sewingV2, 30, 'CHECK_SEAM', words('Verificare la tenuta della cucitura.', 'Check the seam holds.'), { icon: 'check' }, T.rewritten),
        ],
      })
      await tx.workInstructionMedia.createMany({
        data: [
          { id: result.mediaIds.photo, versionId: result.versionIds.sewingV2, stepId: result.stepIds.seam, fileId: result.fileIds.photo, kind: InstructionMediaKind.PHOTO, sortOrder: 10, captionI18n: words('Margine di 10 mm', '10 mm allowance'), ...stamp(T.rewritten) },
          { id: result.mediaIds.video, versionId: result.versionIds.sewingV2, stepId: result.stepIds.seam, fileId: result.fileIds.video, kind: InstructionMediaKind.VIDEO, sortOrder: 20, ...stamp(T.rewritten) },
        ],
      })
      await tx.workInstructionVersion.update({
        where: { id: result.versionIds.sewingV1 },
        data: { status: InstructionVersionStatus.SUPERSEDED, supersededAt: T.republished, updatedAt: T.republished },
        select: { id: true },
      })
      await publish(result.versionIds.sewingV2, T.republished)

      // SEED-WI-0002 v3: a draft, one step and its photo.
      await tx.workInstructionVersion.create({
        data: { id: result.versionIds.sewingDraft, instructionId: result.instructionIds.sewing, number: 3, changeNote: 'A wider allowance on size 54.', authorId: actorId, ...stamp(T.drafted) },
        select: { id: true },
      })
      await tx.workInstructionStep.create({
        data: step(result.stepIds.draft, result.versionIds.sewingDraft, 20, 'SEAM', words('Cucire il fianco a 12 mm dal bordo sulla 54.', 'Sew the side seam 12 mm from the edge on size 54.'), { critical: true }, T.drafted),
        select: { id: true },
      })
      await tx.workInstructionMedia.create({
        data: { id: result.mediaIds.draft, versionId: result.versionIds.sewingDraft, stepId: result.stepIds.draft, fileId: result.fileIds.photo, kind: InstructionMediaKind.PHOTO, sortOrder: 10, ...stamp(T.drafted) },
        select: { id: true },
      })

      // The team leader's paper acknowledgement of SEED-WI-0003 v1, recorded by the office (no device).
      const lead = await tx.worker.findUnique({ where: { id: result.leadId }, select: { employeeId: true } })
      await tx.instructionAcknowledgement.createMany({
        data: [{ id: result.ackIds.paper, siteId: siteA, versionId: result.versionIds.revisionV1, workerId: result.leadId, employeeId: lead?.employeeId ?? null, locale: 'it', acknowledgedAt: T.seen, createdById: actorId }],
      })
      return false
    }),
  )
  if (done) return result

  // --- the operator's acknowledgements on A1's cutting tablet (the floor inserts and never reads them) -------------------
  await db.withScope({ audience: 'floor', tenantId, actorId: result.operatorId, siteId: siteA }, (client) =>
    client.$transaction(async (tx) => {
      const operator = await tx.worker.findUnique({ where: { id: result.operatorId }, select: { employeeId: true } })
      const seen = (rowId: string, versionId: string, event: string): Prisma.InstructionAcknowledgementCreateManyInput => ({
        id: rowId,
        siteId: siteA,
        versionId,
        workerId: result.operatorId,
        employeeId: operator?.employeeId ?? null,
        locale: 'it',
        deviceId: result.deviceId,
        clientEventId: `seed-${event}`,
        deviceTime: T.seen,
        acknowledgedAt: T.seen,
        createdById: result.operatorId,
      })
      await tx.instructionAcknowledgement.createMany({
        data: [seen(result.ackIds.deviceV2, result.versionIds.sewingV2, 'wi-2-v2'), seen(result.ackIds.deviceV1, result.versionIds.sewingV1, 'wi-2-v1')],
      })
    }),
  )
  return result
}
