import { kept, ROWS, section, type PersonSource, type PlannedRecord } from './type'

/**
 * The records about the person beyond their own row (B-W2b-405; PLT-202, PLT-203). Business documents that only name the person
 * by id (a quote, a return, an order line) keep the reference and lose the name with the person's own record: they are listed in
 * the package, never erased. What holds the person's data in its own columns is erased or kept with why:
 *
 *   contactRecords   CONTACT: quotes, inquiries, returns, complaints, service cases, appointments, links sent, safety reports
 *                    (listed); measurement profiles KEPT for the guarantee (MEASUREMENTS; their photos go on their own date)
 *   personalValues   CONTACT of a person party (a rider): the custom values marked personal (fields.personal.view, B-W2b-421)
 *                    DELETED; in the package with their field
 *   workRecords      WORKER: attendance, clock events, absences, overtime, skills, training, scans, the leaver case (listed:
 *                    employment records the law keeps with the employee); the notice acknowledgements KEPT (NOTICE_PROOF)
 *   accountRecords   USER: sessions, roles held, the staff notice acknowledgements KEPT (NOTICE_PROOF)
 */

const byDate = { createdAt: 'asc' as const }

export const contactRecords: PersonSource = {
  key: 'contactRecords',
  kinds: ['CONTACT'],
  async collect(db, person) {
    const contactId = person.recordId
    const take = ROWS + 1
    const [quotes, inquiries, returns, complaints, cases, appointments, links, reports, profiles] = await Promise.all([
      db.quote.findMany({ where: { contactId }, select: { id: true, number: true, status: true, createdAt: true }, orderBy: byDate, take }),
      db.inquiry.findMany({ where: { contactId }, select: { id: true, number: true, status: true, receivedAt: true, request: true }, orderBy: { receivedAt: 'asc' }, take }),
      db.returnAuthorisation.findMany({ where: { contactId }, select: { id: true, number: true, status: true, requestedAt: true, closedAt: true }, orderBy: byDate, take }),
      db.complaint.findMany({ where: { contactId }, select: { id: true, number: true, status: true, receivedAt: true, closedAt: true }, orderBy: byDate, take }),
      db.serviceCase.findMany({ where: { contactId }, select: { id: true, number: true, status: true, createdAt: true, closedAt: true }, orderBy: byDate, take }),
      db.appointment.findMany({ where: { contactId }, select: { id: true, kind: true, startsAt: true, endsAt: true, status: true }, orderBy: { startsAt: 'asc' }, take }),
      db.oneOffLink.findMany({ where: { contactId }, select: { id: true, purpose: true, recordType: true, email: true, createdAt: true, expiresAt: true, revokedAt: true }, orderBy: byDate, take }),
      db.productSafetyReport.findMany({ where: { contactId }, select: { id: true, number: true, status: true, receivedAt: true, whatHappened: true }, orderBy: { receivedAt: 'asc' }, take }),
      db.measurementProfile.findMany({ where: { contactId }, select: { id: true, riderName: true, garmentType: true, revision: true, measurements: true, baseSize: true, fitNotes: true, takenAt: true, photosDeleteAfter: true }, orderBy: { takenAt: 'asc' }, take }),
    ])
    return {
      sections: [
        section('quotes', 'Quotes addressed to the person', quotes),
        section('inquiries', 'Inquiries from the person', inquiries),
        section('returns', 'Returns', returns),
        section('complaints', 'Complaints', complaints),
        section('serviceCases', 'Service cases', cases),
        section('appointments', 'Appointments (fittings, visits)', appointments),
        section('links', 'Links sent to the person', links),
        section('safetyReports', 'Product-safety reports made by the person', reports),
        section('measurements', 'Measurement profiles', profiles),
      ],
      fileRecords: [...profiles.map((row) => ({ recordType: 'MeasurementProfile', recordId: row.id })), ...reports.map((row) => ({ recordType: 'ProductSafetyReport', recordId: row.id }))],
    }
  },
  async plan(db, person) {
    const profiles = await db.measurementProfile.findMany({ where: { contactId: person.recordId }, select: { id: true }, orderBy: { takenAt: 'asc' } })
    return profiles.map((row) => kept('MeasurementProfile', row.id, 'MEASUREMENTS', ['riderName', 'measurements', 'fitNotes']))
  },
}

async function personalValuesOf(db: Parameters<PersonSource['collect']>[0], partyId: string) {
  return db.customFieldValue.findMany({
    where: { recordType: 'Party', recordId: partyId, field: { audience: 'PERSONAL' } },
    select: { id: true, key: true, value: true, changedAt: true, field: { select: { code: true, labelIt: true, labelEn: true, type: true } } },
    orderBy: [{ changedAt: 'asc' }, { id: 'asc' }],
  })
}

export const personalValues: PersonSource = {
  key: 'personalValues',
  kinds: ['CONTACT'],
  async collect(db, person) {
    if (!person.partyIsPerson || !person.partyId) return { sections: [], fileRecords: [] }
    const rows = await personalValuesOf(db, person.partyId)
    return { sections: [section('personalFields', 'Custom fields marked personal', rows.map(({ field, ...value }) => ({ ...value, field: field.code, labelIt: field.labelIt, labelEn: field.labelEn, type: field.type })))], fileRecords: [] }
  },
  async plan(db, person) {
    if (!person.partyIsPerson || !person.partyId) return []
    return (await personalValuesOf(db, person.partyId)).map(
      (row): PlannedRecord => ({
        recordType: 'CustomFieldValue',
        recordId: row.id,
        method: 'DELETED',
        erasedFields: [],
        keptFields: [],
        why: null,
        async apply({ tx }) {
          await tx.customFieldValue.deleteMany({ where: { id: row.id } })
        },
      }),
    )
  },
}

export const workRecords: PersonSource = {
  key: 'workRecords',
  kinds: ['WORKER'],
  async collect(db, person) {
    const employeeId = person.employeeId
    const workerIds = [...person.workerIds]
    const take = ROWS + 1
    const byEmployee = employeeId ? { employeeId } : { employeeId: '00000000-0000-0000-0000-000000000000' }
    const [days, clock, absences, overtime, skills, training, scans, leavers, acks] = await Promise.all([
      db.attendanceDay.findMany({ where: byEmployee, select: { id: true, date: true, status: true, firstInAt: true, lastOutAt: true, presentMinutes: true, breakMinutes: true, ordinaryMinutes: true, overtimeMinutes: true, nightMinutes: true, holidayMinutes: true, absenceMinutes: true }, orderBy: { date: 'asc' }, take }),
      db.clockEvent.findMany({ where: { OR: [byEmployee, { workerId: { in: workerIds } }] }, select: { id: true, kind: true, source: true, occurredAt: true, offSite: true, reason: true }, orderBy: { occurredAt: 'asc' }, take }),
      db.absenceEntry.findMany({ where: byEmployee, select: { id: true, date: true, minutes: true, code: { select: { code: true } } }, orderBy: { date: 'asc' }, take }),
      db.overtimeEntry.findMany({ where: byEmployee, select: { id: true, date: true, status: true, approvedAt: true, rejectedAt: true }, orderBy: { date: 'asc' }, take }),
      db.employeeSkill.findMany({ where: byEmployee, select: { id: true, since: true, assessedAt: true, traineeUntil: true, signedOffOn: true, removedAt: true, skill: { select: { code: true } } }, orderBy: { since: 'asc' }, take }),
      db.trainingRecord.findMany({ where: byEmployee, select: { id: true, completedOn: true, hours: true, validUntil: true, course: { select: { code: true } } }, orderBy: { completedOn: 'asc' }, take }),
      db.operationScan.findMany({ where: { workerId: { in: workerIds } }, select: { id: true, kind: true, serverTime: true, goodQuantity: true, scrapQuantity: true, reworkQuantity: true, workOrderId: true }, orderBy: { serverTime: 'asc' }, take }),
      db.leaverCase.findMany({ where: byEmployee, select: { id: true, lastWorkingDay: true, status: true, startedAt: true, closedAt: true }, orderBy: { startedAt: 'asc' }, take }),
      db.workerNoticeAck.findMany({ where: { workerId: { in: workerIds } }, select: { id: true, noticeVersion: true, locale: true, serverTime: true }, orderBy: { serverTime: 'asc' }, take }),
    ])
    return {
      sections: [
        section('attendance', 'Attendance days', days),
        section('clockEvents', 'Clock-in and clock-out', clock),
        section('absences', 'Absences', absences),
        section('overtime', 'Overtime', overtime),
        section('skills', 'Skills', skills),
        section('training', 'Training records', training),
        section('scans', 'Work recorded by scan', scans),
        section('leaving', 'Leaving', leavers),
        section('noticeAcknowledgements', 'Privacy notices acknowledged', acks),
      ],
      fileRecords: training.map((row) => ({ recordType: 'TrainingRecord', recordId: row.id })),
    }
  },
  async plan(db, person) {
    const acks = await db.workerNoticeAck.findMany({ where: { workerId: { in: [...person.workerIds] } }, select: { id: true }, orderBy: { serverTime: 'asc' } })
    return acks.map((row) => kept('WorkerNoticeAck', row.id, 'NOTICE_PROOF'))
  },
}

export const accountRecords: PersonSource = {
  key: 'accountRecords',
  kinds: ['USER'],
  async collect(db, person) {
    const userId = person.recordId
    const take = ROWS + 1
    const [sessions, roles, acks] = await Promise.all([
      db.session.findMany({ where: { userId }, select: { id: true, audience: true, createdAt: true, lastSeenAt: true, revokedAt: true }, orderBy: { createdAt: 'asc' }, take }),
      db.roleAssignment.findMany({ where: { userId }, select: { id: true, allCompanies: true, companyIds: true, siteIds: true, validFrom: true, validTo: true, endedAt: true, role: { select: { key: true, name: true } } }, orderBy: { createdAt: 'asc' }, take }),
      db.staffNoticeAck.findMany({ where: { userId }, select: { id: true, noticeVersion: true, locale: true, serverTime: true }, orderBy: { serverTime: 'asc' }, take }),
    ])
    return {
      sections: [section('sessions', 'Sign-ins (sessions)', sessions), section('roles', 'Roles held', roles), section('noticeAcknowledgements', 'Privacy notices acknowledged', acks)],
      fileRecords: [],
    }
  },
  async plan(db, person) {
    const acks = await db.staffNoticeAck.findMany({ where: { userId: person.recordId }, select: { id: true }, orderBy: { serverTime: 'asc' } })
    return acks.map((row) => kept('StaffNoticeAck', row.id, 'NOTICE_PROOF'))
  },
}
