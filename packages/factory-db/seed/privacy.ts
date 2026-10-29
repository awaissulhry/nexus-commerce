import { createHash } from 'node:crypto'
import type { Prisma } from '../src/generated/prisma/client'
import { NoticeAckChannel, PrivacyDpiaStatus, PrivacyNoticeKind, PrivacyNoticeStatus } from '../src/generated/prisma/enums'
import { seedUuid, type SeedContext } from '../src/seeding'
import { seed as seedAuth } from './auth'
import { seed as seedFiles } from './files'
import { seed as seedProduction, type ProductionSeed } from './production'

/**
 * The privacy seed (B-W1-36), per tenant of seed/_core.ts, for company A, written as the app does: the office's rows in
 * the tenant's office scope, the worker's acknowledgement in plant A1's floor scope with the operator signed in on the
 * cutting tablet.
 *
 *   worker notice   version 2026-11 PUBLISHED (Italian and English screens) after the production seed's floor day; the
 *                   operator acknowledged it on the tablet; version 2026-12 is a DRAFT (Italian only so far). The team
 *                   leader has acknowledged nothing: no scan names them.
 *   staff notice    version 2026-11 PUBLISHED; the seed's member acknowledged it at sign-in.
 *   public notice   version 2026-11 PUBLISHED: what `/privacy/<company A>` shows.
 *   DPIA            version 1 STORED with its signed PDF (a file row: no object is in any store), signed and stored on
 *                   2026-11-12, reviewed on 2027-11-12; version 2 is a DRAFT. Company A's floor is ready; company B has
 *                   nothing, so its floor stays shut (the gate's words).
 *   register        three processing activities of company A (floor scans, office staff, business contacts).
 *
 * EVERY TEXT HERE IS A MADE-UP SAMPLE and says so: the real notices and the DPIA come from the company's privacy
 * consultant. The CLI runs the seeds in name order and privacy comes before production: run the seeds this one builds on
 * first (all idempotent). The production seed's acknowledgement (version 2026-10, recorded before any notice was
 * published here) stays: once 2026-11 is in force it no longer counts.
 *
 * The generated isolation tests copy the FIRST row of each table by id and insert the copy: a notice is written as a
 * DRAFT, a language only while its notice is a DRAFT, a DPIA as a DRAFT without its PDF, an acknowledgement only of the
 * version in force. So the DRAFT worker notice 2026-12, its Italian text and the DRAFT DPIA get ids that start with
 * eight zeros, and the rows this seed adds to other modules' tables (the operator's acknowledgement, the DPIA's file)
 * ids that start with eight f's. Idempotent: each step runs once and is skipped when its rows exist.
 */

const T = {
  dpiaStored: new Date('2026-11-12T09:00:00.000Z'),
  published: new Date('2026-11-17T07:00:00.000Z'),
  acknowledged: new Date('2026-11-17T07:30:00.000Z'),
  staffAcknowledged: new Date('2026-11-17T08:30:00.000Z'),
  drafted: new Date('2026-11-20T09:00:00.000Z'),
} as const
const DAY = { signed: new Date('2026-11-12T00:00:00.000Z'), review: new Date('2027-11-12T00:00:00.000Z') } as const

const SAMPLE_IT = "ESEMPIO - testo inventato per lo sviluppo. Il testo vero lo scrive il consulente privacy dell'azienda."
const SAMPLE_EN = "SAMPLE - made-up text for development. The real text comes from the company's privacy consultant."

/** The made-up texts, by kind and language. */
const TEXTS: Readonly<Record<'worker' | 'workerDraft' | 'staff' | 'public', Readonly<Record<string, string>>>> = {
  worker: {
    it: [
      SAMPLE_IT,
      'Cosa registra il tablet: quale fascio hai scansionato, a quale fase, quando e su quale postazione.',
      'Perché: i registri di produzione e di qualità.',
      'Cosa non registra mai: la tua posizione, dati biometrici, la telecamera, classifiche delle persone.',
      'A chi chiedere: il personale e il referente privacy.',
    ].join('\n\n'),
    en: [
      SAMPLE_EN,
      'What the tablet records: which bundle you scanned, at which operation, when and at which station.',
      'Why: the production and quality records.',
      'What it never records: where you are, biometric data, a camera on you, rankings of people.',
      'Who to ask: HR and the data protection contact.',
    ].join('\n\n'),
  },
  workerDraft: {
    it: [SAMPLE_IT, 'Bozza della versione 2026-12: aggiunge i tempi di conservazione.'].join('\n\n'),
  },
  staff: {
    it: [SAMPLE_IT, "Cosa conserva il sistema di chi lavora in ufficio: chi ha cambiato cosa (registro delle modifiche) e la posta di lavoro tenuta sulle schede."].join('\n\n'),
    en: [SAMPLE_EN, 'What the system keeps about office staff: who changed what (the audit trail) and work mail kept on record threads.'].join('\n\n'),
  },
  public: {
    it: [SAMPLE_IT, 'Informativa per clienti, fornitori e contatti: quali dati trattiamo, perché, per quanto e i vostri diritti.'].join('\n\n'),
    en: [SAMPLE_EN, 'Notice for customers, suppliers and contacts: which data we process, why, for how long, and your rights.'].join('\n\n'),
  },
}

export interface PrivacySeed {
  readonly production: ProductionSeed
  readonly companyId: string
  /** Company A's notices in force (2026-11), and the DRAFT worker notice 2026-12. */
  readonly workerNoticeId: string
  readonly workerDraftId: string
  readonly staffNoticeId: string
  readonly publicNoticeId: string
  readonly operatorAckId: string
  readonly staffAckId: string
  /** The stored DPIA, its PDF's file row, and the DRAFT that follows it. */
  readonly dpiaId: string
  readonly dpiaFileId: string
  readonly dpiaDraftId: string
  readonly activityIds: readonly string[]
}

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

export async function seed(context: SeedContext): Promise<PrivacySeed> {
  const { db, namespace } = context
  const production = await seedProduction(context)
  const { memberId } = await seedAuth(context)
  await seedFiles(context)
  const id = (key: string): string => seedUuid(namespace, key)
  /** Ids that sort first, and ids that sort last (see above). */
  const firstId = (key: string): string => `00000000${id(key).slice(8)}`
  const lastId = (key: string): string => `ffffffff${id(key).slice(8)}`
  const tenantId = id('tenant')
  const actorId = id('actor')
  const companyA = id('company:A')
  const siteA = id('site:A1')
  const store = id('files:account:r2')
  const office = { audience: 'office' as const, tenantId, actorId }
  const stamp = (at: Date, by: string = actorId) => ({ createdAt: at, updatedAt: at, createdById: by })

  const workerNoticeId = id('privacy:notice:A:WORKER_FLOOR:1')
  const workerDraftId = firstId('privacy:notice:A:WORKER_FLOOR:2')
  const staffNoticeId = id('privacy:notice:A:OFFICE_STAFF:1')
  const publicNoticeId = id('privacy:notice:A:PRIVACY_PUBLIC:1')
  const dpiaId = id('privacy:dpia:A:1')
  const dpiaDraftId = firstId('privacy:dpia:A:2')
  const dpiaFileId = lastId('privacy:file:dpia:A:1')
  const operatorAckId = lastId('privacy:ack:A1:operator:2026-11')
  const staffAckId = id('privacy:staff-ack:A:member:2026-11')

  // --- the notices: each written as a DRAFT with its languages, then published --------------------------------------------
  const notices = [
    { noticeId: workerDraftId, kind: PrivacyNoticeKind.WORKER_FLOOR, versionNo: 2, label: '2026-12', texts: TEXTS.workerDraft, at: T.drafted, publish: false, firstText: true },
    { noticeId: workerNoticeId, kind: PrivacyNoticeKind.WORKER_FLOOR, versionNo: 1, label: '2026-11', texts: TEXTS.worker, at: T.published, publish: true, firstText: false },
    { noticeId: staffNoticeId, kind: PrivacyNoticeKind.OFFICE_STAFF, versionNo: 1, label: '2026-11', texts: TEXTS.staff, at: T.published, publish: true, firstText: false },
    { noticeId: publicNoticeId, kind: PrivacyNoticeKind.PRIVACY_PUBLIC, versionNo: 1, label: '2026-11', texts: TEXTS.public, at: T.published, publish: true, firstText: false },
  ] as const
  for (const notice of notices) {
    await db.withScope(office, (client) =>
      client.$transaction(async (tx) => {
        if (await tx.privacyNotice.findUnique({ where: { id: notice.noticeId }, select: { id: true } })) return
        await tx.privacyNotice.create({
          data: { id: notice.noticeId, companyId: companyA, kind: notice.kind, versionNo: notice.versionNo, label: notice.label, ...stamp(notice.at) },
          select: { id: true },
        })
        for (const [locale, body] of Object.entries(notice.texts)) {
          const key = `privacy:text:${notice.noticeId}:${locale}`
          await tx.privacyNoticeText.create({
            data: { id: notice.firstText && locale === 'it' ? firstId(key) : id(key), noticeId: notice.noticeId, locale, body, sha256: sha256(body), ...stamp(notice.at) },
            select: { id: true },
          })
        }
        if (notice.publish) {
          await tx.privacyNotice.update({
            where: { id: notice.noticeId },
            data: { status: PrivacyNoticeStatus.PUBLISHED, publishedAt: notice.at, publishedById: actorId, version: 2, updatedAt: notice.at },
            select: { id: true },
          })
        }
      }),
    )
  }

  // --- the operator acknowledges the worker notice in force on the cutting tablet -----------------------------------------
  await db.withScope({ audience: 'floor', tenantId, actorId: production.operatorId, siteId: siteA }, (client) =>
    client.$transaction(async (tx) => {
      if (await tx.workerNoticeAck.findUnique({ where: { id: operatorAckId }, select: { id: true } })) return
      await tx.workerNoticeAck.create({
        data: {
          id: operatorAckId,
          siteId: siteA,
          workerId: production.operatorId,
          noticeId: workerNoticeId,
          noticeVersion: '2026-11',
          locale: 'it',
          noticeSha256: sha256(TEXTS.worker.it!),
          channel: NoticeAckChannel.DEVICE,
          deviceId: production.deviceId,
          deviceTime: T.acknowledged,
          serverTime: T.acknowledged,
          createdById: production.operatorId,
        },
        select: { id: true },
      })
    }),
  )

  // --- the member acknowledges the staff notice at sign-in ----------------------------------------------------------------
  await db.withScope({ audience: 'office', tenantId, actorId: memberId }, (client) =>
    client.$transaction(async (tx) => {
      if (await tx.staffNoticeAck.findUnique({ where: { id: staffAckId }, select: { id: true } })) return
      await tx.staffNoticeAck.create({
        data: {
          id: staffAckId,
          companyId: companyA,
          noticeId: staffNoticeId,
          userId: memberId,
          noticeVersion: '2026-11',
          locale: 'en',
          noticeSha256: sha256(TEXTS.staff.en!),
          serverTime: T.staffAcknowledged,
          createdById: memberId,
        },
        select: { id: true },
      })
    }),
  )

  // --- the DPIA: version 1 stored with its signed PDF, version 2 a draft ---------------------------------------------------
  const scope =
    'SAMPLE - made-up scope. Floor tools: badge sign-ins on the tablets and the scans and cut logs that name the signed-in worker. Office staff data: the audit trail and staff mail kept on record threads.'
  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      if (await tx.privacyDpia.findUnique({ where: { id: dpiaId }, select: { id: true } })) return
      await tx.privacyDpia.create({ data: { id: dpiaId, companyId: companyA, versionNo: 1, scope, ...stamp(T.dpiaStored) }, select: { id: true } })
      const pdfSha = sha256(`seed privacy ${namespace} dpia 1`)
      const file: Prisma.StoredFileCreateManyInput = {
        id: dpiaFileId,
        companyId: companyA,
        recordType: 'PrivacyDpia',
        recordId: dpiaId,
        kind: 'DOCUMENT',
        originalName: 'SAMPLE DPIA v1 (signed).pdf',
        contentType: 'application/pdf',
        sizeBytes: 4096,
        sha256: pdfSha,
        storeAccountId: store,
        storageKey: `t/${tenantId}/c/${companyA}/2026/${id('privacy:file:key:dpia:1')}`,
        status: 'AVAILABLE',
        availableAt: T.dpiaStored,
        visibility: ['OFFICE'],
        retainUntil: new Date('2036-11-12T09:00:00.000Z'),
        ...stamp(T.dpiaStored),
      }
      await tx.storedFile.createMany({ data: [file], skipDuplicates: true })
      await tx.privacyDpia.update({
        where: { id: dpiaId },
        data: {
          status: PrivacyDpiaStatus.STORED,
          fileId: dpiaFileId,
          fileSha256: pdfSha,
          signedByName: 'Sample Signer, legal representative (made up)',
          signedOn: DAY.signed,
          reviewDueOn: DAY.review,
          storedAt: T.dpiaStored,
          storedById: actorId,
          version: 2,
          updatedAt: T.dpiaStored,
        },
        select: { id: true },
      })
    }),
  )
  await db.withScope(office, (client) =>
    client.privacyDpia.createMany({ data: [{ id: dpiaDraftId, companyId: companyA, versionNo: 2, scope, ...stamp(T.drafted) }], skipDuplicates: true }),
  )

  // --- the record of processing activities ---------------------------------------------------------------------------------
  const activities: (Prisma.ProcessingActivityCreateManyInput & { id: string })[] = [
    {
      id: id('privacy:activity:A:FLOOR-SCANS'),
      companyId: companyA,
      code: 'FLOOR-SCANS',
      name: 'SAMPLE - floor sign-ins, scans and cut logs',
      purpose: 'Production and quality records of who made what (made up).',
      legalBasis: 'Employment contract and legal obligations (art. 6(1)(b) and (c)), with the art. 4 L. 300/1970 basis on record (made up).',
      dataSubjects: ['floor workers'],
      dataCategories: ['name', 'employee number', 'badge', 'scans and cut logs'],
      recipients: ['production and quality staff'],
      processors: ['hosting, EU (made up)'],
      transfers: 'None outside the EEA (made up).',
      retention: 'Ten years with the batch records (made up).',
      security: 'Row-level security per company and site; hashed badges and PINs; no biometrics (made up).',
      ...stamp(T.dpiaStored),
    },
    {
      id: id('privacy:activity:A:OFFICE-STAFF'),
      companyId: companyA,
      code: 'OFFICE-STAFF',
      name: 'SAMPLE - office staff accounts, audit trail and staff mail',
      purpose: 'Access control and accountability of changes (made up).',
      legalBasis: 'Employment contract and legitimate interest (art. 6(1)(b) and (f)) (made up).',
      dataSubjects: ['office staff'],
      dataCategories: ['name', 'work e-mail', 'actions in the audit trail', 'work mail on record threads'],
      recipients: ['administrators'],
      processors: ['hosting, EU (made up)', 'e-mail delivery, EU (made up)'],
      transfers: 'None outside the EEA (made up).',
      retention: 'While employed, then as the law requires (made up).',
      security: 'Two-factor sign-in for administrators; audit trail append-only (made up).',
      ...stamp(T.dpiaStored),
    },
    {
      id: id('privacy:activity:A:CONTACTS'),
      companyId: companyA,
      code: 'CONTACTS',
      name: 'SAMPLE - customers, suppliers and their contacts',
      purpose: 'Quotes, orders, deliveries and invoices (made up).',
      legalBasis: 'Contract and legal obligations (art. 6(1)(b) and (c)) (made up).',
      dataSubjects: ["customers' and suppliers' contacts"],
      dataCategories: ['name', 'work e-mail', 'phone'],
      recipients: ['carriers', 'the SDI intermediary'],
      processors: ['e-mail delivery, EU (made up)', 'file storage, EU (made up)'],
      transfers: 'None outside the EEA (made up).',
      retention: 'Ten years with the accounting records (made up).',
      security: 'Row-level security per company; one-off links hashed (made up).',
      ...stamp(T.dpiaStored),
    },
  ]
  await db.withScope(office, (client) => client.processingActivity.createMany({ data: activities, skipDuplicates: true }))

  return {
    production,
    companyId: companyA,
    workerNoticeId,
    workerDraftId,
    staffNoticeId,
    publicNoticeId,
    operatorAckId,
    staffAckId,
    dpiaId,
    dpiaFileId,
    dpiaDraftId,
    activityIds: activities.map((activity) => activity.id),
  }
}
