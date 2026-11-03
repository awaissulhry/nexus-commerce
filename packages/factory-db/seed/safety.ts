import { createHash } from 'node:crypto'
import {
  DvrAuthorKind,
  PpeCategory,
  PpeIssueKind,
  PpeIssueReason,
  RiskMeasureSource,
  RiskMeasureStatus,
  RlsNoticeStatus,
  RoleSheetItemKind,
  SafetyCourseType,
  SafetyDeadlineKind,
  SafetyRepeatUnit,
  SafetyRole,
  SafetySignMethod,
  TrainingRequirementSource,
  TrainingResult,
} from '../src/generated/prisma/enums'
import type { Prisma } from '../src/generated/prisma/client'
import { seedUuid, type SeedContext } from '../src/seeding'
import { seed as seedCalendar } from './calendar'
import { seed as seedPeople } from './people'
import { seed as seedPlant } from './plant'

/**
 * The safety at work seed (W2b schema wave 15/16, B-W2b-87), per tenant of seed/_core.ts, written as the app does: the office's
 * rows in the tenant's office scope, the signatures made on plant A1's tablets in A1's floor scope (the operator E1 signs for
 * themselves, the lead E2 countersigns as the trainer). The CLI runs this file by name; it runs the seeds it builds on first
 * (idempotent): people (E1-E5, EB1, their workers and the agency), the plant (the clicking press and its class) and the
 * calendar (the 1T shift). Dates count from today (Europe/Rome), so due, overdue and valid dates stay true whenever it runs.
 *
 *   courses      tenant-wide: general (4 h, no refresher), specific medium and high risk (8 h and 12 h, refreshed every 5
 *                years), first aid (12 h, every 3 years, in person), supervisor (12 h, every 2 years), forklift (every 5 years).
 *   role sheets  A1: Cutter (CUT: noise, manual handling, noise surveillance; gloves at the table, ear defenders at the press,
 *                safety shoes; general + specific high) and Machinist (SEW: repetitive arm movements, upper-limb surveillance;
 *                safety shoes; general + specific medium); B1: Machinist (SEW-B: an apron; general). The clicking press class
 *                asks the specific high course. E1 is a cutter, E2 and E3 machinists, EB1 B1's machinist.
 *   organisation company A: the RSPP and the doctor (outside contacts), the employer (outside, by name), E2 the RLS (signed in
 *                the office) and A1's supervisor, E1 first aid on the 1T shift, E4's ASPP term ended; the RLS notice FILED.
 *                Company B: its territorial RLS (an outside contact) with the notice PENDING, EB1 first aid at B1.
 *   deadlines    the yearly safety meeting (open, evidence required); A1's yearly evacuation drill done last year with its
 *                evidence and the next one open; an authority inspection cancelled.
 *   DVR          A1's assessment: v1 SIGNED by the employer, RSPP, RLS and doctor (the certain date the day of the last one, its
 *                sealed PDF a DVR_FROZEN document), v2 AWAITING_SIGNATURES (the employer signed in the office, the RLS with the
 *                PIN); measures: a noise enclosure IN_PROGRESS (from v1), mats VERIFIED, one from an incident PLANNED, one from
 *                the yearly meeting PLANNED.
 *   training     A1 session S0 (general, 30 days ago, trainer E2): E1 signed with the PIN and E2 countersigned with the PIN, E3
 *                from the paper sheet countersigned in the office; CLOSED, with E1's and E3's records. A1 session S1 (specific
 *                high, trainer E2) OPEN: E1 signed, not countersigned yet. B1 session SB (general) OPEN: EB1 from the paper
 *                sheet. Records typed in the office: E2 general (long ago), E1 specific high (expired), E2 first aid (due in
 *                about three months), E2 supervisor (valid for less than the period, with the reason), E3 specific medium FAILED,
 *                E4 forklift typed by mistake and VOIDED by a correction, E1 first aid with the wrong day and its correction,
 *                EB1 general; E1's expired certificate is a file of its record.
 *   instruction  E1 on the clicking press's die change (unsigned: E1 signs it on the floor), E1 on cutting-table blade change
 *                (signed with the PIN), E3 on the post-bed (signed paper), an entry voided, EB1 at B1 (signed paper).
 *   PPE          company A: cut-resistant gloves (II, sizes 7-10), ear defenders (III, one size), safety shoes (II, 39-44);
 *                company B: a work apron (I, M and L). Issues: E1's gloves received on the floor with the PIN (its receipt PDF a
 *                PPE_RECEIPT document), E2's shoes in the wrong size from a paper receipt and VOIDED, then the right size (its
 *                paper receipt a file of the issue), EB1's apron from a paper receipt at B1.
 *
 * The generated isolation tests (src/isolation.pg.vitest.test.ts) copy the FIRST row of each table by id (tenant A for the
 * office, plant A1 for the floor) and insert the copy: so the first course, role sheet, item, requirement, kit line, PPE item,
 * appointment, RLS notice (PENDING), deadline (OPEN, first of its kind), assessment, version (AWAITING_SIGNATURES), signature (of
 * that version), measure (PLANNED), instruction entry (unsigned) and training record (typed in the office) get ids that start with
 * eight zeros; the first session is SB (OPEN); the office's first attendance and issue are B1's paper ones (00000000…) and the
 * floor's first at A1 are E1's PIN-signed ones (00000001…), neither countersigned. Every name, number and value is invented
 * (made-up people, a made-up consultancy, no real company or doctor). Idempotent: written once, skipped when A1's Cutter sheet
 * exists.
 */

export interface SafetySeed {
  readonly courseIds: {
    readonly general: string
    readonly specificMedium: string
    readonly specificHigh: string
    readonly firstAid: string
    readonly supervisor: string
    readonly forklift: string
  }
  /** A1's Cutter (sorts first) and Machinist, B1's Machinist. */
  readonly roleSheetIds: { readonly cutter: string; readonly machinist: string; readonly machinistB: string }
  readonly ppeItemIds: { readonly gloves: string; readonly earDefenders: string; readonly shoes: string; readonly apron: string }
  readonly appointmentIds: { readonly rspp: string; readonly employer: string; readonly doctor: string; readonly rls: string; readonly rlstB: string }
  readonly assessmentId: string
  /** v1 SIGNED, v2 AWAITING_SIGNATURES (sorts first). */
  readonly versionIds: { readonly v1: string; readonly v2: string }
  /** SB at B1 (OPEN, sorts first), S0 at A1 (CLOSED), S1 at A1 (OPEN). */
  readonly sessionIds: { readonly b1: string; readonly closed: string; readonly open: string }
  /** EB1's paper attendance at SB (00000000…), E1's PIN one at S1 (00000001…), E1's and E3's at S0 (countersigned). */
  readonly attendanceIds: { readonly b1Paper: string; readonly e1Open: string; readonly e1Closed: string; readonly e3Closed: string }
  /** The office's first record (sorts first), E1's expired specific-high record, the forklift record voided. */
  readonly recordIds: { readonly first: string; readonly e1Expired: string; readonly voided: string }
  /** E1's unsigned entry (sorts first), E1's PIN-signed one. */
  readonly instructionIds: { readonly unsigned: string; readonly signed: string }
  /** EB1's paper issue (00000000…), E1's PIN one at A1 (00000001…), E2's voided one. */
  readonly issueIds: { readonly b1Paper: string; readonly e1Floor: string; readonly e2Voided: string }
}

const DAY_MS = 86_400_000

/** Today in Europe/Rome as a UTC midnight. */
function romeToday(): Date {
  const iso = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
  return new Date(`${iso}T00:00:00.000Z`)
}

/** A day plus whole months, the end of the month when the day does not exist there (PostgreSQL's date + interval). */
function addMonths(date: Date, months: number): Date {
  const year = date.getUTCFullYear()
  const month = date.getUTCMonth() + months
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
  return new Date(Date.UTC(year, month, Math.min(date.getUTCDate(), last)))
}

export async function seed(context: SeedContext): Promise<SafetySeed> {
  const { db, namespace } = context
  const people = await seedPeople(context)
  const plant = await seedPlant(context)
  const { patternIds } = await seedCalendar(context)
  const id = (key: string): string => seedUuid(namespace, key)
  /** Ids that sort first (see above); the floor's first rows at A1 come just after B1's. */
  const firstId = (key: string): string => `00000000${id(key).slice(8)}`
  const floorFirstId = (key: string): string => `00000001${id(key).slice(8)}`
  const tenantId = id('tenant')
  const actorId = id('actor')
  const memberId = id('user:member')
  const company = { A: id('company:A'), B: id('company:B') }
  const site = { A1: id('site:A1'), B1: id('site:B1') }
  const worker = { a1Operator: id('worker:A1:operator'), a1Lead: id('worker:A1:lead') }
  const device = { A1: id('device:A1:cutting') }
  const store = id('files:account:r2')
  const e = people.employeeIds
  const office = { audience: 'office' as const, tenantId, actorId }
  const floorAs = (workerId: string) => ({ audience: 'floor' as const, tenantId, actorId: workerId, siteId: site.A1 })
  const select = { id: true } as const
  const sha = (key: string): string => createHash('sha256').update(`seed safety ${key} (${namespace})`).digest('hex')

  const today = romeToday()
  const daysAgo = (days: number): Date => new Date(today.getTime() - days * DAY_MS)
  const daysAhead = (days: number): Date => new Date(today.getTime() + days * DAY_MS)
  /** A time on a day (08:00 UTC plus minutes). */
  const at = (day: Date, minutes = 0): Date => new Date(day.getTime() + 8 * 3_600_000 + minutes * 60_000)
  const now = new Date()
  const stamp = (when: Date = now, by: string | null = actorId) => ({ createdAt: when, updatedAt: when, createdById: by })
  const created = (when: Date = now, by: string | null = actorId) => ({ createdAt: when, createdById: by })

  const courseIds = {
    general: firstId('safety:course:GEN'),
    specificMedium: id('safety:course:SPEC-MED'),
    specificHigh: id('safety:course:SPEC-HIGH'),
    firstAid: id('safety:course:FIRST-AID'),
    supervisor: id('safety:course:SUPERVISOR'),
    forklift: id('safety:course:FORKLIFT'),
  }
  const roleSheetIds = { cutter: firstId('safety:role:A1:CUT'), machinist: id('safety:role:A1:SEW'), machinistB: id('safety:role:B1:SEW-B') }
  const ppeItemIds = { gloves: firstId('safety:ppe:GLOVES-CUT'), earDefenders: id('safety:ppe:EAR-DEF'), shoes: id('safety:ppe:SHOES'), apron: id('safety:ppe:APRON') }
  const appointmentIds = {
    rspp: firstId('safety:appointment:A:RSPP'),
    employer: id('safety:appointment:A:EMPLOYER'),
    doctor: id('safety:appointment:A:DOCTOR'),
    rls: id('safety:appointment:A:RLS:E2'),
    rlstB: id('safety:appointment:B:RLST'),
  }
  const assessmentId = firstId('safety:dvr:A1')
  const versionIds = { v1: id('safety:dvr:A1:v1'), v2: firstId('safety:dvr:A1:v2') }
  const sessionIds = { b1: firstId('safety:session:B1:GEN'), closed: id('safety:session:A1:S0'), open: id('safety:session:A1:S1') }
  const attendanceIds = {
    b1Paper: firstId('safety:attendance:SB:EB1'),
    e1Open: floorFirstId('safety:attendance:S1:E1'),
    e1Closed: id('safety:attendance:S0:E1'),
    e3Closed: id('safety:attendance:S0:E3'),
  }
  const recordIds = { first: firstId('safety:record:E2:GEN'), e1Expired: id('safety:record:E1:SPEC-HIGH'), voided: id('safety:record:E4:FORKLIFT') }
  const instructionIds = { unsigned: firstId('safety:instruction:E1:die-change'), signed: id('safety:instruction:E1:blade-change') }
  const issueIds = { b1Paper: firstId('safety:issue:EB1:apron'), e1Floor: floorFirstId('safety:issue:E1:gloves'), e2Voided: id('safety:issue:E2:shoes-42') }
  const result: SafetySeed = { courseIds, roleSheetIds, ppeItemIds, appointmentIds, assessmentId, versionIds, sessionIds, attendanceIds, recordIds, instructionIds, issueIds }

  const done = await db.withScope(office, (client) => client.roleSheet.findUnique({ where: { id: roleSheetIds.cutter }, select }))
  if (done) return result

  const atA1 = { companyId: company.A, siteId: site.A1 }
  const atB1 = { companyId: company.B, siteId: site.B1 }
  const press = plant.machineIds[1]
  const pressClass = plant.classIds['CLICKING_PRESS']
  const postBedClass = plant.classIds['POST_BED']
  if (!pressClass || !postBedClass) throw new Error('safety seed: the plant seed has no CLICKING_PRESS or POST_BED class')
  const shift1T = patternIds['1T'] ?? null
  const consultancy = 'Seed Safety Consultancy (made-up)'
  /** A stored file of a record, uploaded and available (office only). */
  const file = (key: string, companyId: string, recordType: string, recordId: string, name: string, when: Date, kind: 'DOCUMENT' | 'CERTIFICATE' = 'DOCUMENT') => ({
    id: id(`safety:file:${key}`),
    companyId,
    recordType,
    recordId,
    kind,
    originalName: name,
    contentType: 'application/pdf',
    sizeBytes: 4096,
    sha256: sha(`file ${key}`),
    storeAccountId: store,
    storageKey: `t/${tenantId}/c/${companyId}/safety/${id(`safety:file:key:${key}`)}`,
    status: 'AVAILABLE' as const,
    availableAt: when,
    visibility: ['OFFICE' as const],
    ...stamp(when),
  })

  // ------------------------------------------------------------------------------------------------------------------
  // The office: catalogue, role sheets, organisation, deadlines, the DVR, sessions, paper signatures, typed records.
  // ------------------------------------------------------------------------------------------------------------------
  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      const law = 'D.Lgs. 81/2008 art. 37; Accordo Stato-Regioni (made-up summary)'
      const courses = [
        { id: courseIds.general, code: 'SEED-SC-GEN', name: 'General worker training', nameI18n: { it: 'Formazione generale lavoratori', en: 'General worker training' }, type: SafetyCourseType.GENERAL, hours: '4', sortOrder: 1 },
        { id: courseIds.specificMedium, code: 'SEED-SC-SPEC-MED', name: 'Specific training, medium risk', type: SafetyCourseType.SPECIFIC_MEDIUM, hours: '8', refresherMonths: 60, refresherHours: '6', sortOrder: 2 },
        { id: courseIds.specificHigh, code: 'SEED-SC-SPEC-HIGH', name: 'Specific training, high risk', type: SafetyCourseType.SPECIFIC_HIGH, hours: '12', refresherMonths: 60, refresherHours: '6', sortOrder: 3 },
        { id: courseIds.firstAid, code: 'SEED-SC-FIRST-AID', name: 'First aid team', type: SafetyCourseType.FIRST_AID, hours: '12', refresherMonths: 36, refresherHours: '4', inPersonRequired: true, provider: consultancy, sortOrder: 4 },
        { id: courseIds.supervisor, code: 'SEED-SC-SUPERVISOR', name: 'Supervisor (preposto)', type: SafetyCourseType.SUPERVISOR, hours: '12', refresherMonths: 24, refresherHours: '6', inPersonRequired: true, sortOrder: 5 },
        { id: courseIds.forklift, code: 'SEED-SC-FORKLIFT', name: 'Forklift operator', type: SafetyCourseType.FORKLIFT, hours: '12', refresherMonths: 60, refresherHours: '4', inPersonRequired: true, sortOrder: 6 },
      ]
      for (const course of courses) await tx.safetyCourse.create({ data: { legalBasis: law, ...course, ...stamp() }, select })

      await tx.roleSheet.create({ data: { id: roleSheetIds.cutter, ...atA1, code: 'CUT', name: 'Cutter', nameI18n: { it: 'Tagliatore', en: 'Cutter' }, description: 'Cuts leather and fabric at the table and the clicking press.', ...stamp() }, select })
      await tx.roleSheet.create({ data: { id: roleSheetIds.machinist, ...atA1, code: 'SEW', name: 'Machinist', nameI18n: { it: 'Cucitrice', en: 'Machinist' }, ...stamp() }, select })
      await tx.roleSheet.create({ data: { id: roleSheetIds.machinistB, ...atB1, code: 'SEW-B', name: 'Machinist', ...stamp() }, select })
      const items = [
        { id: firstId('safety:role-item:CUT:1'), siteId: site.A1, roleSheetId: roleSheetIds.cutter, seq: 1, kind: RoleSheetItemKind.RISK, title: 'Noise at the clicking press (above 80 dB(A))' },
        { id: id('safety:role-item:CUT:2'), siteId: site.A1, roleSheetId: roleSheetIds.cutter, seq: 2, kind: RoleSheetItemKind.RISK, title: 'Manual handling of hides and rolls' },
        { id: id('safety:role-item:CUT:3'), siteId: site.A1, roleSheetId: roleSheetIds.cutter, seq: 3, kind: RoleSheetItemKind.SURVEILLANCE, title: 'Noise exposure' },
        { id: id('safety:role-item:SEW:1'), siteId: site.A1, roleSheetId: roleSheetIds.machinist, seq: 1, kind: RoleSheetItemKind.RISK, title: 'Repetitive arm movements at the sewing machine' },
        { id: id('safety:role-item:SEW:2'), siteId: site.A1, roleSheetId: roleSheetIds.machinist, seq: 2, kind: RoleSheetItemKind.SURVEILLANCE, title: 'Upper limbs (repetitive movements)' },
        { id: id('safety:role-item:SEW-B:1'), siteId: site.B1, roleSheetId: roleSheetIds.machinistB, seq: 1, kind: RoleSheetItemKind.RISK, title: 'Repetitive arm movements at the sewing machine' },
      ]
      for (const item of items) await tx.roleSheetItem.create({ data: { ...item, ...stamp() }, select })
      const requirements = [
        { id: firstId('safety:requirement:CUT:GEN'), source: TrainingRequirementSource.ROLE_SHEET, roleSheetId: roleSheetIds.cutter, courseId: courseIds.general, withinDays: null },
        { id: id('safety:requirement:CUT:SPEC-HIGH'), source: TrainingRequirementSource.ROLE_SHEET, roleSheetId: roleSheetIds.cutter, courseId: courseIds.specificHigh, withinDays: 60 },
        { id: id('safety:requirement:SEW:GEN'), source: TrainingRequirementSource.ROLE_SHEET, roleSheetId: roleSheetIds.machinist, courseId: courseIds.general, withinDays: null },
        { id: id('safety:requirement:SEW:SPEC-MED'), source: TrainingRequirementSource.ROLE_SHEET, roleSheetId: roleSheetIds.machinist, courseId: courseIds.specificMedium, withinDays: 60 },
        { id: id('safety:requirement:SEW-B:GEN'), source: TrainingRequirementSource.ROLE_SHEET, roleSheetId: roleSheetIds.machinistB, courseId: courseIds.general, withinDays: null },
        { id: id('safety:requirement:CLICKING_PRESS'), source: TrainingRequirementSource.MACHINE_CLASS, machineClassId: pressClass, courseId: courseIds.specificHigh, withinDays: null, note: 'Before working at a clicking press.' },
      ]
      for (const requirement of requirements) await tx.trainingRequirement.create({ data: { ...requirement, ...stamp() }, select })

      const ppeItems = [
        { id: ppeItemIds.gloves, companyId: company.A, code: 'SEED-PPE-GLOVES-CUT', name: 'Cut-resistant gloves', nameI18n: { it: 'Guanti antitaglio', en: 'Cut-resistant gloves' }, category: PpeCategory.CATEGORY_II, standard: 'EN 388:2016', sizes: ['7', '8', '9', '10'], lifeMonths: 6, supplierPartyId: id('party:P2'), unitCost: 850 },
        { id: ppeItemIds.earDefenders, companyId: company.A, code: 'SEED-PPE-EAR-DEF', name: 'Ear defenders', category: PpeCategory.CATEGORY_III, standard: 'EN 352-1:2020', sizes: [], lifeMonths: 24, unitCost: 1990 },
        { id: ppeItemIds.shoes, companyId: company.A, code: 'SEED-PPE-SHOES', name: 'Safety shoes S3', category: PpeCategory.CATEGORY_II, standard: 'EN ISO 20345:2022', sizes: ['39', '40', '41', '42', '43', '44'], lifeMonths: 12, unitCost: 4500 },
        { id: ppeItemIds.apron, companyId: company.B, code: 'SEED-PPE-APRON-B', name: 'Work apron', category: PpeCategory.CATEGORY_I, sizes: ['M', 'L'], unitCost: 1200 },
      ]
      for (const item of ppeItems) await tx.ppeItem.create({ data: { ...item, ...stamp() }, select })
      const kit = [
        { id: firstId('safety:kit:CUT:1'), siteId: site.A1, roleSheetId: roleSheetIds.cutter, seq: 1, ppeItemId: ppeItemIds.gloves, whenToWear: 'At the cutting table', quantity: 2 },
        { id: id('safety:kit:CUT:2'), siteId: site.A1, roleSheetId: roleSheetIds.cutter, seq: 2, ppeItemId: ppeItemIds.earDefenders, whenToWear: 'At the clicking press' },
        { id: id('safety:kit:CUT:3'), siteId: site.A1, roleSheetId: roleSheetIds.cutter, seq: 3, ppeItemId: ppeItemIds.shoes, whenToWear: 'Always on the floor' },
        { id: id('safety:kit:SEW:1'), siteId: site.A1, roleSheetId: roleSheetIds.machinist, seq: 1, ppeItemId: ppeItemIds.shoes, whenToWear: 'Always on the floor' },
        { id: id('safety:kit:SEW-B:1'), siteId: site.B1, roleSheetId: roleSheetIds.machinistB, seq: 1, ppeItemId: ppeItemIds.apron, whenToWear: 'At the sewing machine' },
      ]
      for (const line of kit) await tx.ppeKitLine.create({ data: { ...line, ...stamp() }, select })
      // The people in each role (Employee.roleSheetId; jobRole stays the HR record's text).
      for (const [employeeId, roleSheetId] of [
        [e.e1, roleSheetIds.cutter],
        [e.e2, roleSheetIds.machinist],
        [e.e3, roleSheetIds.machinist],
        [e.eb1, roleSheetIds.machinistB],
      ] as const) {
        await tx.employee.update({ where: { id: employeeId }, data: { roleSheetId, version: { increment: 1 }, updatedAt: now }, select })
      }

      // The organisation (QHS-224) and the RLS notices (QHS-226).
      const appointedLongAgo = daysAgo(1200)
      const appointments = [
        { id: appointmentIds.rspp, companyId: company.A, role: SafetyRole.RSPP, outsideName: consultancy, fromDate: appointedLongAgo, signedAt: at(appointedLongAgo), signMethod: SafetySignMethod.PAPER, signedName: 'Seed Consultant (made-up)', signedById: actorId },
        { id: appointmentIds.employer, companyId: company.A, role: SafetyRole.EMPLOYER, outsideName: 'Seed Legal Representative (made-up)', fromDate: appointedLongAgo },
        { id: appointmentIds.doctor, companyId: company.A, role: SafetyRole.DOCTOR, outsideName: 'Seed Occupational Doctor (made-up)', fromDate: appointedLongAgo, signedAt: at(appointedLongAgo, 30), signMethod: SafetySignMethod.PAPER, signedName: 'Seed Occupational Doctor (made-up)', signedById: actorId },
        { id: appointmentIds.rls, companyId: company.A, role: SafetyRole.RLS, employeeId: e.e2, fromDate: daysAgo(500), signedAt: at(daysAgo(500)), signMethod: SafetySignMethod.OFFICE, signedName: 'Seed Employee Two', signedById: memberId },
        { id: id('safety:appointment:A1:SUPERVISOR:E2'), ...atA1, role: SafetyRole.SUPERVISOR, employeeId: e.e2, fromDate: daysAgo(500) },
        { id: id('safety:appointment:A1:FIRST_AID:E1'), ...atA1, role: SafetyRole.FIRST_AID, employeeId: e.e1, shiftPatternId: shift1T, fromDate: daysAgo(690) },
        { id: id('safety:appointment:A:ASPP:E4'), companyId: company.A, role: SafetyRole.ASPP, employeeId: e.e4, fromDate: daysAgo(900), untilDate: daysAgo(100), endReason: 'Moved to the production office (made-up)' },
        { id: appointmentIds.rlstB, companyId: company.B, role: SafetyRole.RLST, outsideName: 'Seed Territorial RLS (made-up)', fromDate: daysAgo(10) },
        { id: id('safety:appointment:B1:FIRST_AID:EB1'), ...atB1, role: SafetyRole.FIRST_AID, employeeId: e.eb1, fromDate: daysAgo(300) },
      ]
      for (const appointment of appointments) await tx.safetyAppointment.create({ data: { ...appointment, ...stamp() }, select })
      await tx.storedFile.create({ data: file('appointment:RSPP', company.A, 'SafetyAppointment', appointmentIds.rspp, 'Seed RSPP appointment letter.pdf', at(appointedLongAgo)), select })
      await tx.rlsNotice.create({ data: { id: firstId('safety:rls-notice:B:RLST'), companyId: company.B, appointmentId: appointmentIds.rlstB, dueOn: daysAhead(20), ...stamp() }, select })
      await tx.rlsNotice.create({
        data: { id: id('safety:rls-notice:A:RLS:E2'), companyId: company.A, appointmentId: appointmentIds.rls, dueOn: daysAgo(470), status: RlsNoticeStatus.FILED, filedOn: daysAgo(480), reference: 'SEED-INAIL-0001', filedById: actorId, ...stamp() },
        select,
      })

      // Typed legal deadlines (QHS-227).
      await tx.safetyDeadline.create({
        data: { id: firstId('safety:deadline:A:meeting'), companyId: company.A, title: 'Periodic safety meeting (art. 35)', kind: SafetyDeadlineKind.MEETING, dueOn: daysAhead(40), repeatEvery: 1, repeatUnit: SafetyRepeatUnit.YEAR, ownerId: actorId, evidenceRequired: true, ...stamp() },
        select,
      })
      const drillDone = id('safety:deadline:A1:drill:last')
      await tx.safetyDeadline.create({ data: { id: drillDone, ...atA1, title: 'Evacuation drill', kind: SafetyDeadlineKind.DRILL, dueOn: daysAgo(300), repeatEvery: 1, repeatUnit: SafetyRepeatUnit.YEAR, ownerId: actorId, evidenceRequired: true, ...stamp(at(daysAgo(330))) }, select })
      await tx.storedFile.create({ data: file('drill:last', company.A, 'SafetyDeadline', drillDone, 'Seed evacuation drill report.pdf', at(daysAgo(305))), select })
      await tx.safetyDeadline.update({ where: { id: drillDone }, data: { status: 'DONE', doneAt: at(daysAgo(305)), doneById: actorId, doneNote: 'Everyone out in 4 minutes (made-up).', version: { increment: 1 }, updatedAt: at(daysAgo(305)) }, select })
      await tx.safetyDeadline.create({ data: { id: id('safety:deadline:A1:drill:next'), ...atA1, title: 'Evacuation drill', kind: SafetyDeadlineKind.DRILL, dueOn: daysAhead(65), repeatEvery: 1, repeatUnit: SafetyRepeatUnit.YEAR, ownerId: actorId, evidenceRequired: true, previousId: drillDone, ...stamp(at(daysAgo(305))) }, select })
      const inspection = id('safety:deadline:A1:inspection')
      await tx.safetyDeadline.create({ data: { id: inspection, ...atA1, title: 'Insurer site visit', kind: SafetyDeadlineKind.INSPECTION, dueOn: daysAhead(10), ...stamp(at(daysAgo(20))) }, select })
      await tx.safetyDeadline.update({ where: { id: inspection }, data: { status: 'CANCELLED', cancelledAt: at(daysAgo(5)), cancelReason: 'The insurer moved it to next year (made-up).', version: { increment: 1 }, updatedAt: at(daysAgo(5)) }, select })

      // The DVR (QHS-230): v1 signed by its four signers, v2 waiting for two of them; the improvement plan (QHS-234).
      await tx.riskAssessment.create({ data: { id: assessmentId, ...atA1, name: 'Plant A1', nextReviewOn: daysAhead(300), ...stamp(at(daysAgo(400))) }, select })
      const pdf1 = file('dvr:v1', company.A, 'RiskAssessment', assessmentId, 'Seed DVR plant A1 v1.pdf', at(daysAgo(400)))
      const pdf2 = file('dvr:v2', company.A, 'RiskAssessment', assessmentId, 'Seed DVR plant A1 v2.pdf', at(daysAgo(5)))
      await tx.storedFile.create({ data: pdf1, select })
      await tx.storedFile.create({ data: pdf2, select })
      const signers = [SafetyRole.EMPLOYER, SafetyRole.RSPP, SafetyRole.RLS, SafetyRole.DOCTOR]
      await tx.riskAssessmentVersion.create({
        data: {
          id: versionIds.v1, ...atA1, assessmentId, versionNo: 1, label: 'v1', effectiveOn: daysAgo(395), authorKind: DvrAuthorKind.CONSULTANT, authorName: consultancy,
          changeSummary: 'First assessment of plant A1 (made-up).', fileId: pdf1.id, sha256: pdf1.sha256, frozenAt: at(daysAgo(400)), frozenById: actorId, signersRequired: signers,
          ...stamp(at(daysAgo(400))),
        },
        select,
      })
      const v1Signatures = [
        { role: SafetyRole.EMPLOYER, appointmentId: appointmentIds.employer, signerName: 'Seed Legal Representative (made-up)', on: 399, method: SafetySignMethod.OFFICE, signedById: actorId },
        { role: SafetyRole.RSPP, appointmentId: appointmentIds.rspp, signerName: 'Seed Consultant (made-up)', on: 399, method: SafetySignMethod.PAPER, signedById: actorId },
        { role: SafetyRole.RLS, appointmentId: appointmentIds.rls, signerName: 'Seed Employee Two', on: 398, method: SafetySignMethod.OFFICE, signedById: memberId },
        { role: SafetyRole.DOCTOR, appointmentId: appointmentIds.doctor, signerName: 'Seed Occupational Doctor (made-up)', on: 397, method: SafetySignMethod.PAPER, signedById: actorId },
      ]
      for (const { on, ...signature } of v1Signatures) {
        await tx.riskAssessmentSignature.create({
          data: { id: id(`safety:dvr:A1:v1:${signature.role}`), ...atA1, versionId: versionIds.v1, key: `signature:${versionIds.v1}:${signature.role}`, ...signature, signedOn: daysAgo(on), signedAt: at(daysAgo(on)), signatureSha256: pdf1.sha256, ...created(at(daysAgo(on))) },
          select,
        })
      }
      await tx.riskAssessmentVersion.update({ where: { id: versionIds.v1 }, data: { status: 'SIGNED', certainDateOn: daysAgo(397), signedAt: at(daysAgo(397)), version: { increment: 1 }, updatedAt: at(daysAgo(397)) }, select })
      await tx.riskAssessmentVersion.create({
        data: {
          id: versionIds.v2, ...atA1, assessmentId, versionNo: 2, label: 'v2', effectiveOn: daysAhead(10), authorKind: DvrAuthorKind.CONSULTANT, authorName: consultancy,
          changeSummary: 'The new clicking press and the noise survey (made-up).', fileId: pdf2.id, sha256: pdf2.sha256, frozenAt: at(daysAgo(5)), frozenById: actorId, signersRequired: signers,
          ...stamp(at(daysAgo(5))),
        },
        select,
      })
      await tx.riskAssessmentSignature.create({
        data: {
          id: firstId('safety:dvr:A1:v2:EMPLOYER'), ...atA1, versionId: versionIds.v2, key: `signature:${versionIds.v2}:EMPLOYER`, role: SafetyRole.EMPLOYER, appointmentId: appointmentIds.employer,
          signerName: 'Seed Legal Representative (made-up)', signedOn: daysAgo(4), signedAt: at(daysAgo(4)), method: SafetySignMethod.OFFICE, signedById: actorId, signatureSha256: pdf2.sha256, ...created(at(daysAgo(4))),
        },
        select,
      })
      // The RLS signed on the office's tablet with their badge and PIN.
      await tx.riskAssessmentSignature.create({
        data: {
          id: id('safety:dvr:A1:v2:RLS'), ...atA1, versionId: versionIds.v2, key: `signature:${versionIds.v2}:RLS`, role: SafetyRole.RLS, appointmentId: appointmentIds.rls, signerName: 'Seed Employee Two',
          signedOn: daysAgo(3), signedAt: at(daysAgo(3)), method: SafetySignMethod.FLOOR_PIN, signedByWorkerId: worker.a1Lead, signatureSha256: pdf2.sha256, ...created(at(daysAgo(3))),
        },
        select,
      })
      const measureBase = { ...atA1, assessmentId }
      await tx.riskMeasure.create({ data: { id: firstId('safety:measure:A1:meeting'), ...measureBase, title: 'Mark the walkways in the cutting room', risk: 'Trips with trolleys', source: RiskMeasureSource.MEETING, ownerId: actorId, dueOn: daysAhead(90), cost: 60000, ...stamp() }, select })
      await tx.riskMeasure.create({
        data: { id: id('safety:measure:A1:enclosure'), ...measureBase, title: 'Fit a noise enclosure on the clicking press', risk: 'Noise at the clicking press', roleSheetIds: [roleSheetIds.cutter], status: RiskMeasureStatus.IN_PROGRESS, source: RiskMeasureSource.DVR, versionId: versionIds.v1, ownerId: actorId, dueOn: daysAhead(60), cost: 250000, ...stamp(at(daysAgo(390))) },
        select,
      })
      const mats = id('safety:measure:A1:mats')
      await tx.riskMeasure.create({ data: { id: mats, ...measureBase, title: 'Anti-fatigue mats at the sewing stations', roleSheetIds: [roleSheetIds.machinist], status: RiskMeasureStatus.IN_PROGRESS, source: RiskMeasureSource.DVR, versionId: versionIds.v1, ownerId: actorId, cost: 90000, ...stamp(at(daysAgo(390))) }, select })
      await tx.riskMeasure.update({ where: { id: mats }, data: { status: 'DONE', doneAt: at(daysAgo(200)), doneById: actorId, evidenceNote: 'Mats laid at every station (made-up).', version: { increment: 1 }, updatedAt: at(daysAgo(200)) }, select })
      await tx.riskMeasure.update({ where: { id: mats }, data: { status: 'VERIFIED', verifiedAt: at(daysAgo(150)), verifiedById: memberId, version: { increment: 1 }, updatedAt: at(daysAgo(150)) }, select })
      await tx.riskMeasure.create({
        data: { id: id('safety:measure:A1:incident'), ...measureBase, title: 'Guard on the cutting table blade', risk: 'Cuts at the cutting table', roleSheetIds: [roleSheetIds.cutter], source: RiskMeasureSource.INCIDENT, sourceRecordType: 'Incident', sourceRecordId: id('safety:incident:made-up'), ownerId: actorId, dueOn: daysAhead(15), ...stamp() },
        select,
      })

      // Training sessions (QHS-248): S0 and S1 at A1 with E2 as the trainer, SB at B1 with an outside trainer.
      await tx.trainingSession.create({ data: { id: sessionIds.b1, ...atB1, courseId: courseIds.general, heldOn: daysAhead(2), hours: '4', language: 'it', trainerName: consultancy, location: 'Plant B1 canteen', openedById: actorId, ...stamp() }, select })
      await tx.trainingSession.create({ data: { id: sessionIds.closed, ...atA1, courseId: courseIds.general, heldOn: daysAgo(30), hours: '4', language: 'it', trainerEmployeeId: e.e2, trainerName: 'Seed Employee Two', openedById: actorId, ...stamp(at(daysAgo(31))) }, select })
      await tx.trainingSession.create({ data: { id: sessionIds.open, ...atA1, courseId: courseIds.specificHigh, heldOn: today, hours: '12', language: 'it', trainerEmployeeId: e.e2, trainerName: 'Seed Employee Two', location: 'Cutting room', openedById: actorId, ...stamp() }, select })
      // Paper attendance sheets the office records.
      await tx.trainingAttendance.create({ data: { id: attendanceIds.b1Paper, siteId: site.B1, sessionId: sessionIds.b1, employeeId: e.eb1, key: `attendance:${sessionIds.b1}:${e.eb1}`, method: SafetySignMethod.PAPER, signedAt: at(today), ...stamp() }, select })
      await tx.trainingAttendance.create({ data: { id: attendanceIds.e3Closed, siteId: site.A1, sessionId: sessionIds.closed, employeeId: e.e3, key: `attendance:${sessionIds.closed}:${e.e3}`, method: SafetySignMethod.PAPER, signedAt: at(daysAgo(30), 240), ...stamp(at(daysAgo(30), 250)) }, select })
      await tx.trainingAttendance.update({
        where: { id: attendanceIds.e3Closed },
        data: { countersignedAt: at(daysAgo(30), 255), countersignMethod: SafetySignMethod.OFFICE, countersignedById: memberId, languageUnderstood: true, version: { increment: 1 }, updatedAt: at(daysAgo(30), 255) },
        select,
      })

      // The instruction register (QHS-246): E1's die change waits for E1's PIN; E3's post-bed entry on signed paper; a voided one.
      await tx.instructionRecord.create({
        data: { id: instructionIds.unsigned, ...atA1, employeeId: e.e1, instructedOn: daysAgo(1), task: 'Change the die on the clicking press safely', machineClassId: pressClass, machineId: press, instructorEmployeeId: e.e2, instructorName: 'Seed Employee Two', minutes: 45, language: 'it', languageChecked: true, ...stamp() },
        select,
      })
      await tx.instructionRecord.create({
        data: { id: instructionIds.signed, ...atA1, employeeId: e.e1, instructedOn: daysAgo(20), task: 'Change the cutting table blade', instructorEmployeeId: e.e2, instructorName: 'Seed Employee Two', minutes: 30, language: 'it', ...stamp(at(daysAgo(20))) },
        select,
      })
      await tx.instructionRecord.create({
        data: { id: id('safety:instruction:E3:post-bed'), ...atA1, employeeId: e.e3, instructedOn: daysAgo(40), task: 'Thread and set up the post-bed machine', machineClassId: postBedClass, instructorEmployeeId: e.e2, instructorName: 'Seed Employee Two', minutes: 60, language: 'it', languageChecked: true, signedAt: at(daysAgo(40), 70), signMethod: SafetySignMethod.PAPER, ...stamp(at(daysAgo(40), 75)) },
        select,
      })
      const voidedEntry = id('safety:instruction:E3:wrong')
      await tx.instructionRecord.create({ data: { id: voidedEntry, ...atA1, employeeId: e.e3, instructedOn: daysAgo(39), task: 'Thread the post-bed machine', instructorName: 'Seed Employee Two', minutes: 60, language: 'it', ...stamp(at(daysAgo(39))) }, select })
      await tx.instructionRecord.update({ where: { id: voidedEntry }, data: { voidedAt: at(daysAgo(39), 10), voidedById: actorId, voidReason: 'Typed twice (made-up).', version: { increment: 1 }, updatedAt: at(daysAgo(39), 10) }, select })
      await tx.instructionRecord.create({
        data: { id: id('safety:instruction:EB1:lockstitch'), ...atB1, employeeId: e.eb1, instructedOn: daysAgo(60), task: 'Set up the lockstitch machine', instructorName: consultancy, minutes: 40, language: 'it', signedAt: at(daysAgo(60), 50), signMethod: SafetySignMethod.PAPER, ...stamp(at(daysAgo(60), 55)) },
        select,
      })

      // PPE handed over on paper (QHS-261): EB1's apron; E2's shoes in the wrong size, voided, then the right one.
      await tx.ppeIssue.create({ data: { id: issueIds.b1Paper, ...atB1, kind: PpeIssueKind.ISSUE, employeeId: e.eb1, ppeItemId: ppeItemIds.apron, size: 'M', quantity: 1, reason: PpeIssueReason.NEW, issuedAt: at(daysAgo(50)), issuedById: actorId, method: SafetySignMethod.PAPER, ...created(at(daysAgo(50))) }, select })
      await tx.ppeIssue.create({ data: { id: issueIds.e2Voided, ...atA1, kind: PpeIssueKind.ISSUE, employeeId: e.e2, ppeItemId: ppeItemIds.shoes, size: '42', quantity: 1, reason: PpeIssueReason.NEW, issuedAt: at(daysAgo(12)), issuedById: actorId, method: SafetySignMethod.PAPER, ...created(at(daysAgo(12))) }, select })
      await tx.ppeIssue.create({ data: { id: id('safety:issue:E2:shoes-42:void'), ...atA1, kind: PpeIssueKind.VOID, employeeId: e.e2, ppeItemId: ppeItemIds.shoes, size: '42', quantity: 1, issuedAt: at(daysAgo(12), 20), voidsId: issueIds.e2Voided, voidReason: 'Wrong size: swapped for 43 (made-up).', ...created(at(daysAgo(12), 20)) }, select })
      const shoes43 = id('safety:issue:E2:shoes-43')
      await tx.ppeIssue.create({ data: { id: shoes43, ...atA1, kind: PpeIssueKind.ISSUE, employeeId: e.e2, ppeItemId: ppeItemIds.shoes, size: '43', quantity: 1, reason: PpeIssueReason.REPLACEMENT, issuedAt: at(daysAgo(12), 25), issuedById: actorId, method: SafetySignMethod.PAPER, ...created(at(daysAgo(12), 25)) }, select })
      await tx.storedFile.create({ data: file('issue:E2:shoes-43', company.A, 'PpeIssue', shoes43, 'Seed signed PPE receipt.pdf', at(daysAgo(12), 30)), select })

      // Training records typed in the office (QHS-243, QHS-244).
      type RecordData = Omit<Prisma.TrainingRecordUncheckedCreateInput, 'id' | 'language' | 'trainerName' | 'createdAt' | 'createdById'> & { completedOn: Date }
      const record = (key: string, data: RecordData): Prisma.TrainingRecordUncheckedCreateInput => ({ id: id(`safety:record:${key}`), language: 'it', trainerName: consultancy, ...data, ...created(at(data.completedOn, 600)) })
      const firstAidWrong = id('safety:record:E1:FIRST-AID:wrong-day')
      const records = [
        { ...record('E2:GEN', { companyId: company.A, employeeId: e.e2, courseId: courseIds.general, completedOn: daysAgo(900), hours: '4', result: TrainingResult.PASSED }), id: recordIds.first },
        record('E1:SPEC-HIGH', { companyId: company.A, employeeId: e.e1, courseId: courseIds.specificHigh, completedOn: daysAgo(2000), hours: '12', result: TrainingResult.PASSED, validUntil: addMonths(daysAgo(2000), 60), languageChecked: true }),
        record('E2:FIRST-AID', { companyId: company.A, employeeId: e.e2, courseId: courseIds.firstAid, completedOn: daysAgo(1000), hours: '12', result: TrainingResult.PASSED, validUntil: addMonths(daysAgo(1000), 36) }),
        record('E2:SUPERVISOR', { companyId: company.A, employeeId: e.e2, courseId: courseIds.supervisor, completedOn: daysAgo(200), hours: '12', result: TrainingResult.PASSED, validUntil: addMonths(daysAgo(200), 12), validUntilReason: "The provider's certificate is valid for one year (made-up)." }),
        record('E3:SPEC-MED', { companyId: company.A, employeeId: e.e3, courseId: courseIds.specificMedium, completedOn: daysAgo(20), hours: '8', result: TrainingResult.FAILED, note: 'To repeat at the next session.' }),
        { ...record('E4:FORKLIFT', { companyId: company.A, employeeId: e.e4, courseId: courseIds.forklift, completedOn: daysAgo(100), hours: '12', result: TrainingResult.PASSED, validUntil: addMonths(daysAgo(100), 60) }), id: recordIds.voided },
        record('E4:FORKLIFT:void', { companyId: company.A, employeeId: e.e4, courseId: courseIds.forklift, completedOn: daysAgo(100), hours: '0', result: TrainingResult.VOID, correctsId: recordIds.voided, correctionReason: 'Typed for the wrong person (made-up).' }),
        { ...record('E1:FIRST-AID:wrong-day', { companyId: company.A, employeeId: e.e1, courseId: courseIds.firstAid, completedOn: daysAgo(700), hours: '12', result: TrainingResult.PASSED, validUntil: addMonths(daysAgo(700), 36) }), id: firstAidWrong },
        record('E1:FIRST-AID', { companyId: company.A, employeeId: e.e1, courseId: courseIds.firstAid, completedOn: daysAgo(698), hours: '12', result: TrainingResult.PASSED, validUntil: addMonths(daysAgo(698), 36), correctsId: firstAidWrong, correctionReason: 'The course ended two days later (made-up).' }),
        record('EB1:GEN', { companyId: company.B, employeeId: e.eb1, courseId: courseIds.general, completedOn: daysAgo(500), hours: '4', result: TrainingResult.PASSED }),
      ]
      for (const row of records) await tx.trainingRecord.create({ data: row, select })
      await tx.storedFile.create({ data: file('record:E1:SPEC-HIGH', company.A, 'TrainingRecord', recordIds.e1Expired, 'Seed certificate specific training.pdf', at(daysAgo(2000), 700), 'CERTIFICATE'), select })
    }),
  )

  // ------------------------------------------------------------------------------------------------------------------
  // Plant A1's tablet, the operator E1 signed in: attendance at S0 and S1, the gloves received, the blade-change entry signed.
  // ------------------------------------------------------------------------------------------------------------------
  await db.withScope(floorAs(worker.a1Operator), (client) =>
    client.$transaction(async (tx) => {
      const pin = { signedByWorkerId: worker.a1Operator, deviceId: device.A1 }
      await tx.trainingAttendance.create({
        data: { id: attendanceIds.e1Closed, siteId: site.A1, sessionId: sessionIds.closed, employeeId: e.e1, key: `attendance:${sessionIds.closed}:${e.e1}`, method: SafetySignMethod.FLOOR_PIN, signedAt: at(daysAgo(30), 240), ...pin, clientEventId: 'seed-attendance-s0-e1', signatureSha256: sha('attendance S0 E1'), createdAt: at(daysAgo(30), 240), updatedAt: at(daysAgo(30), 240) },
        select,
      })
      await tx.trainingAttendance.create({
        data: { id: attendanceIds.e1Open, siteId: site.A1, sessionId: sessionIds.open, employeeId: e.e1, key: `attendance:${sessionIds.open}:${e.e1}`, method: SafetySignMethod.FLOOR_PIN, signedAt: now, ...pin, clientEventId: 'seed-attendance-s1-e1', signatureSha256: sha('attendance S1 E1'), createdAt: now, updatedAt: now },
        select,
      })
      await tx.ppeIssue.create({
        data: { id: issueIds.e1Floor, siteId: site.A1, companyId: company.A, kind: PpeIssueKind.ISSUE, employeeId: e.e1, ppeItemId: ppeItemIds.gloves, size: '9', quantity: 2, reason: PpeIssueReason.NEW, issuedAt: at(daysAgo(25)), issuedByWorkerId: worker.a1Lead, method: SafetySignMethod.FLOOR_PIN, ...pin, clientEventId: 'seed-ppe-e1-gloves', signatureSha256: sha('ppe E1 gloves'), createdAt: at(daysAgo(25)) },
        select,
      })
      await tx.instructionRecord.update({
        where: { id: instructionIds.signed },
        data: { signedAt: at(daysAgo(20), 40), signMethod: SafetySignMethod.FLOOR_PIN, signedByWorkerId: worker.a1Operator, signatureSha256: sha('instruction E1 blade'), version: { increment: 1 }, updatedAt: at(daysAgo(20), 40) },
        select,
      })
    }),
  )

  // The trainer E2 countersigns E1's attendance at S0 with their PIN, having checked E1 understood Italian.
  await db.withScope(floorAs(worker.a1Lead), (client) =>
    client.trainingAttendance.update({
      where: { id: attendanceIds.e1Closed },
      data: { countersignedAt: at(daysAgo(30), 250), countersignMethod: SafetySignMethod.FLOOR_PIN, countersignedByWorkerId: worker.a1Lead, languageUnderstood: true, version: { increment: 1 }, updatedAt: at(daysAgo(30), 250) },
      select,
    }),
  )

  // ------------------------------------------------------------------------------------------------------------------
  // The office closes S0 and records E1's and E3's training from it; the PPE receipt and the frozen DVR as documents.
  // ------------------------------------------------------------------------------------------------------------------
  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      await tx.trainingSession.update({ where: { id: sessionIds.closed }, data: { status: 'CLOSED', closedAt: at(daysAgo(29)), closedById: actorId, version: { increment: 1 }, updatedAt: at(daysAgo(29)) }, select })
      for (const [key, employeeId, attendanceId] of [
        ['E1', e.e1, attendanceIds.e1Closed],
        ['E3', e.e3, attendanceIds.e3Closed],
      ] as const) {
        await tx.trainingRecord.create({
          data: {
            id: id(`safety:record:S0:${key}`), companyId: company.A, employeeId, courseId: courseIds.general, sessionId: sessionIds.closed, attendanceId, completedOn: daysAgo(30), hours: '4',
            trainerName: 'Seed Employee Two', result: TrainingResult.PASSED, language: 'it', languageChecked: true, ...created(at(daysAgo(29), 10)),
          },
          select,
        })
      }
      const receipt = file('issue:E1:gloves:receipt', company.A, 'PpeIssue', issueIds.e1Floor, 'Seed PPE receipt E1.pdf', at(daysAgo(25), 5))
      await tx.storedFile.create({ data: receipt, select })
      await tx.generatedDocument.create({
        data: { id: id('safety:document:PPE_RECEIPT:E1'), ...atA1, recordType: 'PpeIssue', recordId: issueIds.e1Floor, kind: 'PPE_RECEIPT', version: 1, fingerprint: sha('receipt E1 gloves'), language: 'it', fileId: receipt.id, createdAt: at(daysAgo(25), 5), createdById: null },
        select,
      })
      const sealed = file('dvr:v1:sealed', company.A, 'RiskAssessmentVersion', versionIds.v1, 'Seed DVR plant A1 v1 sealed.pdf', at(daysAgo(397), 30))
      await tx.storedFile.create({ data: sealed, select })
      await tx.generatedDocument.create({
        data: { id: id('safety:document:DVR_FROZEN:v1'), ...atA1, recordType: 'RiskAssessmentVersion', recordId: versionIds.v1, kind: 'DVR_FROZEN', version: 1, fingerprint: sha('dvr v1 sealed'), language: 'it', fileId: sealed.id, createdAt: at(daysAgo(397), 30), createdById: actorId },
        select,
      })
    }),
  )
  return result
}
