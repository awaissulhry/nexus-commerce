import { createHash } from 'node:crypto'
import type { Prisma } from '../src/generated/prisma/client'
import {
  EarningsKind,
  GuaranteedPayBasis,
  HeldScanReason,
  HeldScanStatus,
  IncentiveKind,
  IncentiveSchemeStatus,
  MonitoringBasis,
  PayPeriodStatus,
  PayrollCodeKind,
  PayrollExportFileKind,
  PayrollExportStatus,
  PayrollFileFormat,
  PieceRateBasis,
  PieceRateChangeReason,
  PieceRateVersionStatus,
  PiecePayState,
  PeoplePurpose,
  RateAckChannel,
  TeamSplitBasis,
} from '../src/generated/prisma/enums'
import { seedUuid, type SeedContext } from '../src/seeding'
import { seed as seedFiles } from './files'
import { seed as seedNumbering } from './numbering'
import { seed as seedPeople } from './people'
import { seed as seedPrivacy } from './privacy'
import { seed as seedProduction, type ProductionSeed } from './production'

/**
 * The piece pay and payroll export seed (W2b schema wave 6/7), per tenant of seed/_core.ts, written in the tenant's
 * office scope as the app does (the receipt too: the API writes a tablet reading in the tenant's system context). Every
 * figure, name and reference is MADE UP (no real CCNL rate, no real consultant, no real payroll code). The rows about one
 * person name them by employeeId: the operator is seed/people.ts's E1 (SEED-A1-1), the team leader E2.
 *
 *   legal switch  B-W2b-30 (the lead's decision, plan §2/§11: the build ships every people purpose OFF): the DEFAULT seed
 *                 (the CLI, `seed(context)`) leaves piece pay and every people purpose OFF: A1's switch is OFF with its
 *                 preconditions on record (a made-up CCNL and article, company A's worker notice 2026-10 in force and its
 *                 stored DPIA (seed/privacy.ts), a made-up labour consultant's agreement, the company's ACTIVE scheme, A1's
 *                 floor rules naming workers on a union agreement (seed/production.ts)), no PERFORMANCE gate is written
 *                 (seed/people.ts's ATTENDANCE gate stays off), and the held scans, the ledger and the statement below are
 *                 not written (they exist only while piece pay is on). A test that needs piece pay ON passes the explicit
 *                 opt-in `seed(context, { piecePay: true })`: then A1's PERFORMANCE legal gate is switched on (a made-up
 *                 union agreement; people.prisma PeopleLegalGate) and A1's switch is ON from 2026-11-13, and the ledger is
 *                 written.
 *                 B1: OFF with nothing on record (it records the station only, so piece pay can never start there as it is).
 *                 A new site has no row: OFF by default.
 *   scheme        company A's pure piece rate from 2026-11-01, guaranteed 9.00 an hour (made up), own-fault rework and
 *                 scrap unpaid, waiting at the average rate, scans pay only while clocked in: ACTIVE; a DRAFT team incentive
 *                 for A1's line from 2027-01-01, its guaranteed pay not given yet.
 *   rates         A1's table for SEED-JKT-02 (seed/production.ts's style): version 1 PUBLISHED from 2026-11-13 (published
 *                 to the operator on 2026-11-12, read on the cutting tablet the same day): sewing 96.5 SMV × 0.12 = 11.58 a
 *                 piece, packing 0.30 a piece (fixed); version 2 a provisional DRAFT from 2027-01-01 (method changed:
 *                 sewing 90 SMV × 0.12 = 10.80), trial until 2027-02-28.
 *   periods       company A's October 2026 LOCKED (nothing paid in it); November 2026 OPEN.
 *   ledger        (opt-in only) the operator's standing sewing report of 2026-11-17 (2 pieces × 11.58 = 23.16): it was held (not
 *                 clocked in) and counted once the attendance was fixed, then paid; a made-up adjustment of 5.00 typed by
 *                 mistake and its reversal (corrections are new entries). The operator's undone mis-scan of the same
 *                 morning is held and still OPEN.
 *   statement     (opt-in only) the operator's November statement, a DRAFT.
 *   payroll       the generic CSV layout (data, as every layout); five code mappings (two mapped to made-up provider codes,
 *                 three not yet); PAY-2026-0001, October 2026, EXPORTED with its empty data file and summary (the number
 *                 from the company's PAYROLL_EXPORT series, its NumberAllocation row written and the series moved to 2, as
 *                 allocateNumber does); November's export a DRAFT whose job wrote the data file so far.
 *
 * The generated isolation tests (src/isolation.pg.vitest.test.ts) copy the FIRST row of each table by id and insert the
 * copy: a rate version and its rates are written while it is a DRAFT; a scheme starts as a DRAFT; a period OPEN; a held
 * scan OPEN; a statement a DRAFT; an export a DRAFT and a file goes only into a DRAFT export; an earnings entry's copy must
 * pass its checks again (a counted hold, a rate in force, the switch's window). So the DRAFT rate version and its rate,
 * the DRAFT scheme, November's period, the OPEN held scan, the statement, the SCAN entry, November's export and its file
 * get ids that start with eight zeros (still derived from the namespace); the legal switch rows have their site's id (a
 * copy of A1's ON row passes the same gate: the switch is created OFF, or ON with every precondition on record); the
 * rows this seed adds to other modules' tables (files, the number allocation) start with eight f's or are plain.
 *
 * Idempotent: each record is written once, in one transaction, and skipped when it exists (the ledger and the receipts
 * are append-only, a published version, a locked period and an exported export never change).
 */

const T = {
  schemeActivated: new Date('2026-11-10T08:00:00.000Z'),
  schemeDrafted: new Date('2026-11-20T08:00:00.000Z'),
  ratesDrafted: new Date('2026-11-11T08:00:00.000Z'),
  published: new Date('2026-11-12T10:00:00.000Z'),
  read: new Date('2026-11-12T14:00:00.000Z'),
  gateOn: new Date('2026-11-12T15:00:00.000Z'),
  switchedOn: new Date('2026-11-12T16:00:00.000Z'),
  octoberRun: new Date('2026-11-02T08:00:00.000Z'),
  octoberReview: new Date('2026-11-03T08:00:00.000Z'),
  octoberLocked: new Date('2026-11-04T08:00:00.000Z'),
  octoberExported: new Date('2026-11-04T10:00:00.000Z'),
  novemberOpened: new Date('2026-11-01T06:00:00.000Z'),
  // seed/production.ts: the undone mis-scan and the standing sewing report.
  misScanned: new Date('2026-11-17T08:00:00.000Z'),
  reported: new Date('2026-11-17T09:30:00.000Z'),
  held: new Date('2026-11-17T09:35:00.000Z'),
  counted: new Date('2026-11-18T08:00:00.000Z'),
  paid: new Date('2026-11-18T08:05:00.000Z'),
  adjusted: new Date('2026-11-18T09:00:00.000Z'),
  reversed: new Date('2026-11-18T09:10:00.000Z'),
  statement: new Date('2026-11-25T08:00:00.000Z'),
  rates2: new Date('2026-11-26T08:00:00.000Z'),
  novemberDraft: new Date('2026-11-28T08:00:00.000Z'),
} as const
const DAY = {
  schemeFrom: new Date('2026-11-01T00:00:00.000Z'),
  draftSchemeFrom: new Date('2027-01-01T00:00:00.000Z'),
  ratesFrom: new Date('2026-11-13T00:00:00.000Z'),
  rates2From: new Date('2027-01-01T00:00:00.000Z'),
  rates2TrialEnd: new Date('2027-02-28T00:00:00.000Z'),
  consultantAgreed: new Date('2026-11-11T00:00:00.000Z'),
  october: { first: new Date('2026-10-01T00:00:00.000Z'), last: new Date('2026-10-31T00:00:00.000Z') },
  november: { first: new Date('2026-11-01T00:00:00.000Z'), last: new Date('2026-11-30T00:00:00.000Z') },
  worked: new Date('2026-11-17T00:00:00.000Z'),
  exportedOctober: new Date('2026-11-04T00:00:00.000Z'),
} as const
const YEAR = '2026'
/** Sewing: 96.5 standard minutes × 0.12 a minute = 11.58 a piece; 2 pieces = 23.16 (minor units 2316). */
const RATES = { sewMinutes: '96.500', perMinute: '0.120000', sewPiece: '11.580000', packPiece: '0.300000', sew2Minutes: '90.000', sew2Piece: '10.800000' } as const
const PAID = { pieces: 2, amount: 2_316, adjustment: 500 } as const
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

/** The generic CSV layout: one row per employee code and pay code. */
const GENERIC_CSV = {
  columns: [
    { key: 'employeeCode', header: 'Matricola' },
    { key: 'code', header: 'Voce' },
    { key: 'quantity', header: 'Quantita' },
    { key: 'amount', header: 'Importo' },
  ],
  delimiter: ';',
  decimalSeparator: ',',
  dateFormat: 'DD/MM/YYYY',
  encoding: 'UTF-8',
  headerRow: true,
} as const

/** B-W2b-30: the default seed leaves piece pay and every people purpose OFF; a test that needs them ON says so here. */
export interface PaySeedOptions {
  /** A1's PERFORMANCE gate and piece pay switched ON, the held scans, the ledger and the statement written. */
  readonly piecePay?: boolean
}

export interface PaySeed {
  readonly production: ProductionSeed
  /** seed/people.ts's employees of A1's operator (E1) and team leader (E2). */
  readonly employeeIds: { readonly operator: string; readonly lead: string }
  /** A1's PERFORMANCE legal gate, switched on with `{ piecePay: true }` only (piece pay's precondition). */
  readonly performanceGateId: string
  /** The legal switches (each with its site's id): A1 ON with `{ piecePay: true }`, else OFF; B1 OFF. */
  readonly switchIds: { readonly on: string; readonly off: string }
  /** Company A's ACTIVE scheme and A1 line's DRAFT one. */
  readonly schemeIds: { readonly active: string; readonly draft: string }
  readonly rateTableId: string
  /** Version 1 (PUBLISHED) and version 2 (DRAFT, provisional). */
  readonly rateVersionIds: { readonly published: string; readonly draft: string }
  readonly rateEntryIds: { readonly sew: string; readonly pack: string; readonly sew2: string }
  readonly publicationId: string
  readonly acknowledgementId: string
  /** October 2026 (LOCKED) and November 2026 (OPEN). */
  readonly periodIds: { readonly october: string; readonly november: string }
  /** The undone mis-scan's hold (OPEN) and the standing report's (COUNTED). */
  readonly heldScanIds: { readonly open: string; readonly counted: string }
  /** The paid scan, the adjustment and its reversal. */
  readonly entryIds: { readonly scan: string; readonly adjustment: string; readonly reversal: string }
  readonly statementId: string
  readonly layoutId: string
  readonly mappingIds: readonly string[]
  /** PAY-2026-0001 (October, EXPORTED) and its files; November's DRAFT export and its file. */
  readonly exportedId: string
  readonly exportedFileIds: readonly string[]
  readonly draftExportId: string
  readonly draftFileId: string
  /** Company A's PAYROLL_EXPORT series for the year. */
  readonly exportSeriesId: string
}

export async function seed(context: SeedContext, options: PaySeedOptions = {}): Promise<PaySeed> {
  const { db, namespace } = context
  // The CLI runs the seeds in name order: run what this one builds on (all idempotent): the production seed (A1's floor
  // rules naming workers, SEED-JKT-02 and its work order, the operator's scans, the cutting tablet, the worker notice),
  // the privacy seed (company A's stored DPIA), the people seed (the employees of the floor workers), numbering (the
  // PAYROLL_EXPORT series) and files (the store).
  const production = await seedProduction(context)
  const privacy = await seedPrivacy(context)
  const people = await seedPeople(context)
  const employee = { operator: people.employeeIds.e1, lead: people.employeeIds.e2 }
  await seedNumbering(context)
  await seedFiles(context)
  const id = (key: string): string => seedUuid(namespace, key)
  const firstId = (key: string): string => `00000000${id(key).slice(8)}`
  const lastId = (key: string): string => `ffffffff${id(key).slice(8)}`
  const tenantId = id('tenant')
  const actorId = id('actor')
  const companyA = id('company:A')
  const companyB = id('company:B')
  const siteA = id('site:A1')
  const siteB = id('site:B1')
  const lineA = id('site:A1:line:L1')
  const store = id('files:account:r2')
  const operation = { sew: id('product:operation:SEW'), pack: id('product:operation:PACK') }
  const operatorCode = 'SEED-A1-1'
  const exportSeriesId = `ffffffff${id(`series:A:PAYROLL_EXPORT:MAIN:${YEAR}`).slice(8)}`
  const office = { audience: 'office' as const, tenantId, actorId }
  const stamp = (at: Date) => ({ createdAt: at, updatedAt: at, createdById: actorId })
  const select = { id: true } as const
  const document = (key: string, recordType: string, recordId: string, name: string, contentType: string, at: Date): Prisma.StoredFileCreateManyInput => ({
    id: lastId(`pay:file:${key}`),
    companyId: companyA,
    recordType,
    recordId,
    kind: 'DOCUMENT',
    originalName: name,
    contentType,
    sizeBytes: 1024,
    sha256: sha256(`seed pay ${namespace} ${key}`),
    storeAccountId: store,
    storageKey: `t/${tenantId}/c/${companyA}/${YEAR}/${id(`pay:file:key:${key}`)}`,
    status: 'AVAILABLE',
    availableAt: at,
    visibility: ['OFFICE'],
    ...stamp(at),
  })

  const switchIds = { on: siteA, off: siteB }
  // Sorts after seed/people.ts's switched-off gate (the isolation tests copy the first row: one gate in force per site
  // and purpose).
  const performanceGateId = lastId('pay:gate:A1:PERFORMANCE')
  const schemeIds = { active: id('pay:scheme:A:2026-11'), draft: firstId('pay:scheme:A1:L1:2027-01') }
  const rateTableId = id('pay:rates:A1:JKT-02')
  const rateVersionIds = { published: id('pay:rates:A1:JKT-02:1'), draft: firstId('pay:rates:A1:JKT-02:2') }
  const rateEntryIds = { sew: id('pay:rates:A1:JKT-02:1:SEW'), pack: id('pay:rates:A1:JKT-02:1:PACK'), sew2: firstId('pay:rates:A1:JKT-02:2:SEW') }
  const publicationId = id('pay:publication:A1:JKT-02:1')
  const acknowledgementId = id('pay:receipt:A1:JKT-02:1:operator')
  const periodIds = { october: id('pay:period:A:2026-10'), november: firstId('pay:period:A:2026-11') }
  const heldScanIds = { open: firstId('pay:held:scan-1'), counted: id('pay:held:scan-3') }
  const entryIds = { scan: firstId('pay:entry:scan-3'), adjustment: id('pay:entry:adjustment-1'), reversal: id('pay:entry:adjustment-1:reversal') }
  const statementId = firstId('pay:statement:A:2026-11:operator:1')
  const layoutId = id('pay:layout:A:generic-csv')
  const mappings = [
    { key: 'HOUR:ORD', kind: PayrollCodeKind.HOUR, ourCode: 'ORD', meaning: 'Ordinary hours', providerCode: 'ESEMPIO-001' },
    { key: 'HOUR:OT', kind: PayrollCodeKind.HOUR, ourCode: 'OT', meaning: 'Overtime hours', providerCode: null },
    { key: 'ABSENCE:FER', kind: PayrollCodeKind.ABSENCE, ourCode: 'FER', meaning: 'Holiday (ferie)', providerCode: null },
    { key: 'EARNING:PIECE', kind: PayrollCodeKind.EARNING, ourCode: 'PIECE', meaning: 'Piece pay', providerCode: 'ESEMPIO-310' },
    { key: 'EARNING:MAKE_UP', kind: PayrollCodeKind.EARNING, ourCode: 'MAKE_UP', meaning: 'Make-up to guaranteed pay', providerCode: null },
  ] as const
  const mappingIds = mappings.map((mapping) => id(`pay:mapping:A:${mapping.key}`))
  const exportedId = id('pay:export:A:2026-10')
  const draftExportId = firstId('pay:export:A:2026-11')
  const exportedFiles = [
    document('export:A:2026-10:data', 'PayrollExport', exportedId, 'PAY-2026-0001.csv', 'text/csv', T.octoberExported),
    document('export:A:2026-10:summary', 'PayrollExport', exportedId, 'PAY-2026-0001-summary.pdf', 'application/pdf', T.octoberExported),
  ]
  const exportedFileIds = [id('pay:export-file:A:2026-10:1'), id('pay:export-file:A:2026-10:2')]
  const draftFile = document('export:A:2026-11:data', 'PayrollExport', draftExportId, 'PAY-2026-11-draft.csv', 'text/csv', T.novemberDraft)
  const draftFileId = firstId('pay:export-file:A:2026-11:1')
  const layoutSnapshot = { format: PayrollFileFormat.DELIMITED, definition: GENERIC_CSV }

  // --- incentive schemes ------------------------------------------------------------------------------------------------
  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      if (await tx.incentiveScheme.findUnique({ where: { id: schemeIds.active }, select })) return
      await tx.incentiveScheme.create({
        data: {
          id: schemeIds.active,
          companyId: companyA,
          name: 'Cottimo puro (esempio)',
          kind: IncentiveKind.PIECE_RATE,
          guaranteedBasis: GuaranteedPayBasis.CCNL_MINIMUM,
          guaranteedHourlyRate: '9.000000',
          validFrom: DAY.schemeFrom,
          note: 'Made-up figures for the seed; the CCNL and the labour consultant give the real ones.',
          ...stamp(T.schemeActivated),
        },
        select,
      })
      await tx.incentiveScheme.update({
        where: { id: schemeIds.active },
        data: { status: IncentiveSchemeStatus.ACTIVE, activatedAt: T.schemeActivated, activatedById: actorId, version: 2 },
        select,
      })
      await tx.incentiveScheme.create({
        data: {
          id: schemeIds.draft,
          companyId: companyA,
          siteId: siteA,
          lineId: lineA,
          name: 'Incentivo di squadra linea L1 (bozza)',
          kind: IncentiveKind.TEAM_INCENTIVE,
          teamSplit: TeamSplitBasis.HOURS_PRESENT,
          validFrom: DAY.draftSchemeFrom,
          ...stamp(T.schemeDrafted),
        },
        select,
      })
    }),
  )

  // --- A1's rate table: version 1 published to the operator and read; version 2 a provisional draft --------------------
  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      if (await tx.pieceRateTable.findUnique({ where: { id: rateTableId }, select })) return
      await tx.pieceRateTable.create({
        data: { id: rateTableId, companyId: companyA, siteId: siteA, code: 'JKT-02', name: 'SEED-JKT-02 (esempio)', styleId: production.styleId, ...stamp(T.ratesDrafted) },
        select,
      })
      await tx.pieceRateVersion.create({
        data: {
          id: rateVersionIds.published,
          companyId: companyA,
          siteId: siteA,
          tableId: rateTableId,
          versionNo: 1,
          changeReason: PieceRateChangeReason.NEW,
          changeNote: 'First rates of the style (made up).',
          effectiveFrom: DAY.ratesFrom,
          ...stamp(T.ratesDrafted),
        },
        select,
      })
      await tx.pieceRateEntry.createMany({
        data: [
          {
            id: rateEntryIds.sew,
            siteId: siteA,
            versionId: rateVersionIds.published,
            operationId: operation.sew,
            basis: PieceRateBasis.SMV_RATE,
            standardMinutes: RATES.sewMinutes,
            ratePerMinute: RATES.perMinute,
            ratePerPiece: RATES.sewPiece,
            ...stamp(T.ratesDrafted),
          },
          {
            id: rateEntryIds.pack,
            siteId: siteA,
            versionId: rateVersionIds.published,
            operationId: operation.pack,
            basis: PieceRateBasis.FIXED,
            ratePerPiece: RATES.packPiece,
            ...stamp(T.ratesDrafted),
          },
        ],
      })
      await tx.ratePublication.create({
        data: {
          id: publicationId,
          companyId: companyA,
          siteId: siteA,
          versionId: rateVersionIds.published,
          lineId: lineA,
          workerIds: [production.operatorId],
          onFloor: true,
          printed: true,
          publishedAt: T.published,
          publishedById: actorId,
          ...stamp(T.published),
        },
        select,
      })
      await tx.pieceRateVersion.update({
        where: { id: rateVersionIds.published },
        data: { status: PieceRateVersionStatus.PUBLISHED, version: 2, updatedAt: T.published },
        select,
      })
    }),
  )
  // The operator reads the published rates on the cutting tablet: the API records the receipt (system context).
  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      if (await tx.rateAcknowledgement.findUnique({ where: { id: acknowledgementId }, select })) return
      await tx.rateAcknowledgement.create({
        data: {
          id: acknowledgementId,
          siteId: siteA,
          publicationId,
          versionId: rateVersionIds.published,
          employeeId: employee.operator,
          workerId: production.operatorId,
          channel: RateAckChannel.DEVICE,
          deviceId: production.deviceId,
          deviceTime: T.read,
          clientEventId: 'seed-rate-receipt-1',
          serverTime: T.read,
          createdById: actorId,
        },
        select,
      })
    }),
  )
  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      if (await tx.pieceRateVersion.findUnique({ where: { id: rateVersionIds.draft }, select })) return
      await tx.pieceRateVersion.create({
        data: {
          id: rateVersionIds.draft,
          companyId: companyA,
          siteId: siteA,
          tableId: rateTableId,
          versionNo: 2,
          changeReason: PieceRateChangeReason.METHOD_CHANGED,
          changeNote: 'Sleeves set with a new folder: fewer standard minutes (made up).',
          effectiveFrom: DAY.rates2From,
          provisional: true,
          trialEndsOn: DAY.rates2TrialEnd,
          ...stamp(T.rates2),
        },
        select,
      })
      await tx.pieceRateEntry.create({
        data: {
          id: rateEntryIds.sew2,
          siteId: siteA,
          versionId: rateVersionIds.draft,
          operationId: operation.sew,
          basis: PieceRateBasis.SMV_RATE,
          standardMinutes: RATES.sew2Minutes,
          ratePerMinute: RATES.perMinute,
          ratePerPiece: RATES.sew2Piece,
          ...stamp(T.rates2),
        },
        select,
      })
    }),
  )

  // --- the legal switches: A1 OFF with its preconditions, B1 OFF; A1's gate and switch ON only with the opt-in ----------
  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      if (await tx.piecePaySwitch.findUnique({ where: { id: switchIds.on }, select })) return
      await tx.piecePaySwitch.createMany({
        data: [
          {
            id: switchIds.on,
            companyId: companyA,
            siteId: siteA,
            ccnlName: 'CCNL ESEMPIO (made up)',
            ccnlArticle: 'Art. 0 (esempio)',
            workerNoticeId: production.workerNoticeId,
            dpiaId: privacy.dpiaId,
            consultantName: 'Studio Esempio (made up)',
            consultantAgreedOn: DAY.consultantAgreed,
            schemeId: schemeIds.active,
            preconditionsNote: 'Seed sample: every reference is made up.',
            ...stamp(T.switchedOn),
          },
          { id: switchIds.off, companyId: companyB, siteId: siteB, ...stamp(T.switchedOn) },
        ],
      })
    }),
  )
  if (options.piecePay) {
    await db.withScope(office, (client) =>
      client.$transaction(async (tx) => {
        const a1 = await tx.piecePaySwitch.findUniqueOrThrow({ where: { id: switchIds.on }, select: { state: true, version: true } })
        if (a1.state === PiecePayState.ON) return
        if (!(await tx.peopleLegalGate.findUnique({ where: { id: performanceGateId }, select }))) {
          await tx.peopleLegalGate.create({
            data: {
              id: performanceGateId,
              companyId: companyA,
              siteId: siteA,
              purpose: PeoplePurpose.PERFORMANCE,
              basis: MonitoringBasis.UNION_AGREEMENT,
              basisReference: 'SAMPLE - accordo RSU 2026/02 on piece rates (made up)',
              noticeId: production.workerNoticeId,
              dpiaId: privacy.dpiaId,
              switchedOnAt: T.gateOn,
              switchedOnById: actorId,
              ...stamp(T.gateOn),
            },
            select,
          })
        }
        await tx.piecePaySwitch.update({
          where: { id: switchIds.on },
          data: { state: PiecePayState.ON, onFrom: DAY.ratesFrom, switchedOnAt: T.switchedOn, switchedOnById: actorId, version: a1.version + 1 },
          select,
        })
      }),
    )
  }

  // --- pay periods: October locked (nothing paid in it), November open --------------------------------------------------
  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      if (await tx.payPeriod.findUnique({ where: { id: periodIds.october }, select })) return
      await tx.payPeriod.createMany({
        data: [
          { id: periodIds.october, companyId: companyA, periodStart: DAY.october.first, periodEnd: DAY.october.last, ...stamp(T.octoberRun) },
          { id: periodIds.november, companyId: companyA, periodStart: DAY.november.first, periodEnd: DAY.november.last, ...stamp(T.novemberOpened) },
        ],
      })
      await tx.payPeriod.update({ where: { id: periodIds.october }, data: { status: PayPeriodStatus.PREVIEW, previewedAt: T.octoberRun, previewedById: actorId, version: 2 }, select })
      await tx.payPeriod.update({ where: { id: periodIds.october }, data: { status: PayPeriodStatus.REVIEW, reviewStartedAt: T.octoberReview, reviewStartedById: actorId, version: 3 }, select })
      await tx.payPeriod.update({
        where: { id: periodIds.october },
        data: { status: PayPeriodStatus.LOCKED, lockedAt: T.octoberLocked, lockedById: actorId, lockNote: 'Nothing paid by the piece in October (made up).', version: 4 },
        select,
      })
    }),
  )

  // --- held scans and the ledger (piece pay ON only: the opt-in) -------------------------------------------------------------
  if (options.piecePay) await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      if (await tx.heldScan.findUnique({ where: { id: heldScanIds.counted }, select })) return
      const [misScan, , report] = production.scanIds
      await tx.heldScan.createMany({
        data: [
          {
            id: heldScanIds.open,
            companyId: companyA,
            siteId: siteA,
            payPeriodId: periodIds.november,
            employeeId: employee.operator,
            workerId: production.operatorId,
            operationScanId: misScan,
            reason: HeldScanReason.NOT_CLOCKED_IN,
            heldAt: T.misScanned,
            key: `held:${misScan}`,
            ...stamp(T.misScanned),
          },
          {
            id: heldScanIds.counted,
            companyId: companyA,
            siteId: siteA,
            payPeriodId: periodIds.november,
            employeeId: employee.operator,
            workerId: production.operatorId,
            operationScanId: report,
            reason: HeldScanReason.NOT_CLOCKED_IN,
            heldAt: T.held,
            key: `held:${report}`,
            ...stamp(T.held),
          },
        ],
      })
      await tx.heldScan.update({
        where: { id: heldScanIds.counted },
        data: {
          status: HeldScanStatus.COUNTED,
          resolvedAt: T.counted,
          resolvedById: actorId,
          resolutionNote: 'Forgot to badge in; the lead confirmed the start time (made up).',
          // W2b wave 5's attendance day (not on main yet): a made-up id of that record.
          fixRecordType: 'AttendanceDay',
          fixRecordId: id('time:attendance-day:A1:operator:2026-11-17'),
          version: 2,
          updatedAt: T.counted,
        },
        select,
      })
      await tx.earningsEntry.create({
        data: {
          id: entryIds.scan,
          companyId: companyA,
          siteId: siteA,
          payPeriodId: periodIds.november,
          employeeId: employee.operator,
          workerId: production.operatorId,
          workDate: DAY.worked,
          kind: EarningsKind.SCAN,
          operationScanId: report,
          rateEntryId: rateEntryIds.sew,
          pieces: PAID.pieces,
          rate: RATES.sewPiece,
          amount: PAID.amount,
          heldScanId: heldScanIds.counted,
          idempotencyKey: `scan:${report}`,
          createdAt: T.paid,
          createdById: actorId,
        },
        select,
      })
      await tx.earningsEntry.create({
        data: {
          id: entryIds.adjustment,
          companyId: companyA,
          siteId: siteA,
          payPeriodId: periodIds.november,
          employeeId: employee.operator,
          workerId: production.operatorId,
          workDate: DAY.worked,
          kind: EarningsKind.ADJUSTMENT,
          amount: PAID.adjustment,
          reason: 'Bonus typed on the wrong worker (made up).',
          idempotencyKey: `adjustment:${id('pay:adjustment:1')}`,
          createdAt: T.adjusted,
          createdById: actorId,
        },
        select,
      })
      await tx.earningsEntry.create({
        data: {
          id: entryIds.reversal,
          companyId: companyA,
          siteId: siteA,
          payPeriodId: periodIds.november,
          employeeId: employee.operator,
          workerId: production.operatorId,
          workDate: DAY.worked,
          kind: EarningsKind.ADJUSTMENT,
          amount: -PAID.adjustment,
          reversalOfId: entryIds.adjustment,
          reason: 'Typed on the wrong worker: reversed.',
          idempotencyKey: `reversal:${entryIds.adjustment}`,
          createdAt: T.reversed,
          createdById: actorId,
        },
        select,
      })
      await tx.workerStatement.create({
        data: { id: statementId, companyId: companyA, siteId: siteA, payPeriodId: periodIds.november, employeeId: employee.operator, ...stamp(T.statement) },
        select,
      })
    }),
  )

  // --- payroll: the generic layout, the code mapping, October's export and November's draft -----------------------------
  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      if (await tx.payrollExportLayout.findUnique({ where: { id: layoutId }, select })) return
      await tx.payrollExportLayout.create({
        data: { id: layoutId, companyId: companyA, name: 'Generic CSV', format: PayrollFileFormat.DELIMITED, definition: GENERIC_CSV, ...stamp(T.octoberRun) },
        select,
      })
      await tx.payrollCodeMapping.createMany({
        data: mappings.map((mapping, index) => ({
          id: mappingIds[index] as string,
          companyId: companyA,
          kind: mapping.kind,
          ourCode: mapping.ourCode,
          meaning: mapping.meaning,
          providerCode: mapping.providerCode,
          ...stamp(T.octoberRun),
        })),
      })
      await tx.payrollExport.create({
        data: {
          id: exportedId,
          companyId: companyA,
          periodStart: DAY.october.first,
          periodEnd: DAY.october.last,
          payPeriodId: periodIds.october,
          layoutId,
          layoutSnapshot,
          checks: [
            { code: 'MONTH_CLOSED', blocking: true, passed: true },
            { code: 'EMPLOYEE_CODES', blocking: true, passed: true, count: 0 },
            { code: 'PAY_PERIOD_LOCKED', blocking: true, passed: true },
            { code: 'CODES_MAPPED', blocking: true, passed: true },
            { code: 'AGENCY_WORKERS_LEFT_OUT', blocking: false, passed: true, count: 0 },
          ],
          values: [],
          note: 'The month before the first piece pay: an empty file (made up).',
          ...stamp(T.octoberExported),
        },
        select,
      })
      await tx.storedFile.createMany({ data: exportedFiles, skipDuplicates: true })
      await tx.payrollExportFile.createMany({
        data: [
          { id: exportedFileIds[0] as string, exportId: exportedId, seq: 1, kind: PayrollExportFileKind.DATA, fileId: exportedFiles[0]!.id as string, format: 'CSV', rowCount: 0, createdAt: T.octoberExported, createdById: actorId },
          { id: exportedFileIds[1] as string, exportId: exportedId, seq: 2, kind: PayrollExportFileKind.SUMMARY, fileId: exportedFiles[1]!.id as string, format: 'PDF', rowCount: 0, createdAt: T.octoberExported, createdById: actorId },
        ],
      })
      // The number, as allocateNumber gives it: the series' next value, its NumberAllocation row, the series moved on.
      await tx.numberAllocation.createMany({
        data: [
          {
            id: lastId('pay:allocation:PAY-2026-0001'),
            companyId: companyA,
            seriesId: exportSeriesId,
            kind: 'PAYROLL_EXPORT',
            value: 1,
            formatted: `PAY-${YEAR}-0001`,
            documentDate: DAY.exportedOctober,
            recordType: 'PayrollExport',
            recordId: exportedId,
            allocatedAt: T.octoberExported,
            allocatedById: actorId,
            requestId: 'seed-pay-PAY-2026-0001',
          },
        ],
        skipDuplicates: true,
      })
      await tx.numberSeries.update({ where: { id: exportSeriesId }, data: { nextValue: 2, lastIssuedDate: DAY.exportedOctober, updatedAt: T.octoberExported }, select })
      await tx.payrollExport.update({
        where: { id: exportedId },
        data: {
          status: PayrollExportStatus.EXPORTED,
          numberSeriesId: exportSeriesId,
          number: `PAY-${YEAR}-0001`,
          exportedAt: T.octoberExported,
          exportedById: actorId,
          version: 2,
          updatedAt: T.octoberExported,
        },
        select,
      })
      await tx.payrollExport.create({
        data: {
          id: draftExportId,
          companyId: companyA,
          periodStart: DAY.november.first,
          periodEnd: DAY.november.last,
          payPeriodId: periodIds.november,
          layoutId,
          layoutSnapshot,
          checks: [
            { code: 'MONTH_CLOSED', blocking: true, passed: false },
            { code: 'PAY_PERIOD_LOCKED', blocking: true, passed: false },
            { code: 'CODES_MAPPED', blocking: true, passed: false, count: 3 },
          ],
          values: [{ employeeCode: operatorCode, code: 'PIECE', amount: PAID.amount }],
          ...stamp(T.novemberDraft),
        },
        select,
      })
      await tx.storedFile.createMany({ data: [draftFile], skipDuplicates: true })
      await tx.payrollExportFile.create({
        data: { id: draftFileId, exportId: draftExportId, seq: 1, kind: PayrollExportFileKind.DATA, fileId: draftFile.id as string, format: 'CSV', rowCount: 1, createdAt: T.novemberDraft, createdById: actorId },
        select,
      })
    }),
  )

  return {
    production,
    employeeIds: employee,
    performanceGateId,
    switchIds,
    schemeIds,
    rateTableId,
    rateVersionIds,
    rateEntryIds,
    publicationId,
    acknowledgementId,
    periodIds,
    heldScanIds,
    entryIds,
    statementId,
    layoutId,
    mappingIds,
    exportedId,
    exportedFileIds,
    draftExportId,
    draftFileId,
    exportSeriesId,
  }
}
