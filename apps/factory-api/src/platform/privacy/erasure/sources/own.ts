import { ERASED_NAME, EMPLOYMENT_KEEP_MONTHS, erasedEmailOf, HEALTH_KEEP_MONTHS, type KeptWhy } from '@nexus/factory-domain/privacy/retention/erasure'
import { kept, NONE, ROWS, section, type PersonFacts, type PersonSource, type PlannedRecord, type Reader } from './type'

/**
 * The person's own record (B-W2b-405; PLT-202, PLT-203): the contact, the prospect's columns of the inquiry, the reporter's
 * columns of the safety report, the office account, the employee record and the floor accounts. Erased as the database keeps
 * them erased (B-W2b-279/290/295/351's columns), with the law's holds first:
 *
 *   CONTACT   an open complaint, return or service case of the contact keeps it (DISPUTE); else name '', no e-mail, no phone,
 *             ARCHIVED, erasedAt/ById (party.contact_erased). A person party (a rider) keeps its customer record (CUSTOMER).
 *   PROSPECT  the four prospect columns blank for good, prospectErasedAt/ById. The lawful basis stays (threads plan follow-up,
 *             TH-2 notes Open 3): it names no one, the retention sweep keeps it too, and a CLOSED request (declined, lost) is frozen
 *             by the database but for its note and this erasure — blanking the basis there was refused and the erasure failed.
 *   REPORTER  a report still being assessed keeps the reporter's details (SAFETY_REPORT); a closed one blanks them
 *             (safety_report.erased REPORTER); the report itself stays.
 *   USER      a deactivated account: the name becomes a mark, the e-mail an address that never delivers.
 *   WORKER    the employee record is kept 5 years after the employment ends (EMPLOYMENT), 10 with health or accident records
 *             (HEALTH), and while a labour dispute is open (DISPUTE); afterwards the names become a mark. The floor accounts follow.
 */

const monthsAfter = (date: Date, months: number): Date => {
  const out = new Date(date.getTime())
  out.setUTCMonth(out.getUTCMonth() + months)
  return out
}

/**
 * The personal columns of each of a person's own records: what the erasure blanks in the record, and the keys it blanks inside
 * the record's audit rows (B-W2b-F54: the history keeps no value its record no longer holds).
 */
export const PERSONAL_COLUMNS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  PartyContact: ['name', 'email', 'phone'],
  // Threads plan follow-up (TH-2 notes, Open 3): the lawful basis is no personal data and stays (see PROSPECT above).
  Inquiry: ['prospectName', 'prospectCompany', 'prospectEmail', 'prospectPhone'],
  ProductSafetyReport: ['reporterName', 'reporterEmail', 'reporterPhone'],
  User: ['displayName', 'email'],
  Employee: ['firstName', 'lastName', 'displayName'],
  Worker: ['displayName', 'pinHash'],
})

const columnsOf = (recordType: string): string[] => [...(PERSONAL_COLUMNS[recordType] ?? [])]

/**
 * The legal hold on the person's own record, or null (B-W2b-F54: the same hold keeps what they wrote and received, and their
 * record's history, as they are): an open complaint, return or service case of a contact (DISPUTE); a safety report still being
 * assessed (SAFETY_REPORT); a worker's open labour dispute, health or accident records (10 years) or employment records (5 years)
 * after the employment ended.
 */
export async function ownHold(db: Reader, person: PersonFacts, now: Date): Promise<KeptWhy | null> {
  switch (person.kind) {
    case 'CONTACT': {
      const contactId = person.recordId
      const open = (await db.complaint.count({ where: { contactId, status: { not: 'CLOSED' } } })) + (await db.returnAuthorisation.count({ where: { contactId, status: { notIn: ['CLOSED', 'REJECTED', 'CANCELLED'] } } })) + (await db.serviceCase.count({ where: { contactId, status: { notIn: ['RESOLVED', 'CLOSED'] } } }))
      return open > 0 ? 'DISPUTE' : null
    }
    case 'REPORTER': {
      const report = await db.productSafetyReport.findUnique({ where: { id: person.recordId }, select: { status: true } })
      return report && report.status !== 'CLOSED' ? 'SAFETY_REPORT' : null
    }
    case 'WORKER': {
      const employee = person.employeeId ? await db.employee.findUnique({ where: { id: person.employeeId }, select: { id: true, endDate: true, updatedAt: true } }) : null
      const ended = employee?.endDate ?? employee?.updatedAt ?? now
      const disputes = await db.labourDispute.count({ where: { status: 'OPEN', OR: [{ workerId: { in: [...person.workerIds] } }, ...(employee ? [{ employeeId: employee.id }] : [])] } })
      const health = employee ? (await db.healthVisit.count({ where: { employeeId: employee.id } })) + (await db.fitnessJudgement.count({ where: { employeeId: employee.id } })) + (await db.incidentPerson.count({ where: { employeeId: employee.id } })) : 0
      return disputes > 0 ? 'DISPUTE' : health > 0 && monthsAfter(ended, HEALTH_KEEP_MONTHS).getTime() > now.getTime() ? 'HEALTH' : monthsAfter(ended, EMPLOYMENT_KEEP_MONTHS).getTime() > now.getTime() ? 'EMPLOYMENT' : null
    }
    case 'PROSPECT':
    case 'USER':
      return null
  }
}

export const ownRecords: PersonSource = {
  key: 'own',
  kinds: ['CONTACT', 'PROSPECT', 'REPORTER', 'USER', 'WORKER'],

  async collect(db, person) {
    switch (person.kind) {
      case 'CONTACT': {
        const row = await db.partyContact.findUnique({
          where: { id: person.recordId },
          select: { id: true, name: true, email: true, phone: true, roles: true, language: true, status: true, lawfulBasis: true, consentAt: true, consentSource: true, objectedAt: true, erasedAt: true, createdAt: true, updatedAt: true, party: { select: { code: true, legalName: true, kind: true } } },
        })
        if (!row) return NONE
        const { party, ...contact } = row
        return { sections: [section('person', 'The contact', [{ ...contact, organisation: party.code, organisationName: party.legalName, organisationKind: party.kind }])], fileRecords: [] }
      }
      case 'PROSPECT': {
        const row = await db.inquiry.findUnique({
          where: { id: person.recordId },
          select: { id: true, number: true, source: true, receivedAt: true, prospectName: true, prospectCompany: true, prospectEmail: true, prospectPhone: true, prospectLawfulBasis: true, prospectErasedAt: true, request: true, wantedDate: true, status: true, note: true, closedAt: true },
        })
        if (!row) return NONE
        const lines = await db.inquiryLine.findMany({ where: { inquiryId: row.id }, select: { seq: true, description: true, colourText: true, sizes: true, quantity: true, note: true }, orderBy: { seq: 'asc' } })
        return { sections: [section('person', 'The inquiry and the prospect', [row]), section('inquiryLines', 'What was asked', lines)], fileRecords: [{ recordType: 'Inquiry', recordId: row.id }] }
      }
      case 'REPORTER': {
        const row = await db.productSafetyReport.findUnique({
          where: { id: person.recordId },
          select: { id: true, number: true, source: true, receivedAt: true, reporterName: true, reporterEmail: true, reporterPhone: true, whatHappened: true, garmentSerial: true, garmentBatch: true, status: true, closedAt: true },
        })
        return row ? { sections: [section('person', 'The safety report and its reporter', [row])], fileRecords: [{ recordType: 'ProductSafetyReport', recordId: row.id }] } : NONE
      }
      case 'USER': {
        const row = await db.user.findUnique({ where: { id: person.recordId }, select: { id: true, email: true, displayName: true, locale: true, status: true, audience: true, requireMfa: true, totpConfirmedAt: true, lastSignInAt: true, passwordChangedAt: true, accessUntil: true, createdAt: true } })
        return row ? { sections: [section('person', 'The office account', [row])], fileRecords: [] } : NONE
      }
      case 'WORKER': {
        const employee = person.employeeId
          ? await db.employee.findUnique({ where: { id: person.employeeId }, select: { id: true, employeeCode: true, firstName: true, lastName: true, displayName: true, kind: true, locale: true, startDate: true, endDate: true, department: true, jobRole: true, contract: true, weeklyMinutes: true, status: true, createdAt: true } })
          : null
        const workers = await db.worker.findMany({ where: { id: { in: [...person.workerIds] } }, select: { id: true, siteId: true, displayName: true, locale: true, employeeCode: true, status: true, pinChangedAt: true, createdAt: true }, orderBy: { createdAt: 'asc' }, take: ROWS + 1 })
        return {
          sections: [...(employee ? [section('employee', 'The employee record', [employee])] : []), section('floorAccounts', 'The floor accounts (badge sign-in)', workers)],
          fileRecords: employee ? [{ recordType: 'Employee', recordId: employee.id }] : [],
        }
      }
    }
  },

  async plan(db, person, now) {
    switch (person.kind) {
      case 'CONTACT': {
        if (person.erased) return [kept('PartyContact', person.recordId, 'ALREADY_ERASED')]
        const contactId = person.recordId
        const hold = await ownHold(db, person, now)
        const planned: PlannedRecord[] = []
        if (hold) planned.push(kept('PartyContact', contactId, hold, columnsOf('PartyContact')))
        else {
          planned.push({
            recordType: 'PartyContact',
            recordId: contactId,
            method: 'ANONYMISED',
            erasedFields: columnsOf('PartyContact'),
            keptFields: [],
            why: null,
            async apply({ tx, now: at, actorId, emit }) {
              const contact = await tx.partyContact.findUniqueOrThrow({ where: { id: contactId }, select: { partyId: true, party: { select: { code: true, companyId: true } } } })
              await tx.partyContact.update({ where: { id: contactId }, data: { name: '', email: null, phone: null, status: 'ARCHIVED', erasedAt: at, erasedById: actorId, version: { increment: 1 }, updatedAt: at }, select: { id: true } })
              emit({ type: 'party.contact_erased', subject: contact.partyId, companyId: contact.party.companyId, payload: { partyId: contact.partyId, code: contact.party.code, contactId } })
            },
          })
        }
        if (person.partyIsPerson && person.partyId) planned.push(kept('Party', person.partyId, 'CUSTOMER', ['legalName', 'tradeName']))
        return planned
      }
      case 'PROSPECT': {
        if (person.erased) return [kept('Inquiry', person.recordId, 'ALREADY_ERASED')]
        const inquiryId = person.recordId
        return [
          {
            recordType: 'Inquiry',
            recordId: inquiryId,
            method: 'ANONYMISED',
            erasedFields: columnsOf('Inquiry'),
            keptFields: [],
            why: null,
            async apply({ tx, now: at, actorId }) {
              // The lawful basis stays (threads plan follow-up): a closed request takes only the erasure of its prospect.
              await tx.inquiry.update({ where: { id: inquiryId }, data: { prospectName: null, prospectCompany: null, prospectEmail: null, prospectPhone: null, prospectErasedAt: at, prospectErasedById: actorId, version: { increment: 1 }, updatedAt: at }, select: { id: true } })
            },
          },
        ]
      }
      case 'REPORTER': {
        if (person.erased) return [kept('ProductSafetyReport', person.recordId, 'ALREADY_ERASED')]
        const reportId = person.recordId
        const hold = await ownHold(db, person, now)
        if (hold) return [kept('ProductSafetyReport', reportId, hold, columnsOf('ProductSafetyReport'))]
        return [
          {
            recordType: 'ProductSafetyReport',
            recordId: reportId,
            method: 'ANONYMISED',
            erasedFields: columnsOf('ProductSafetyReport'),
            keptFields: [],
            why: null,
            async apply({ tx, now: at, emit }) {
              const row = await tx.productSafetyReport.findUniqueOrThrow({ where: { id: reportId }, select: { number: true, companyId: true } })
              await tx.productSafetyReport.update({ where: { id: reportId }, data: { reporterName: null, reporterEmail: null, reporterPhone: null, version: { increment: 1 }, updatedAt: at }, select: { id: true } })
              emit({ type: 'safety_report.erased', subject: reportId, companyId: row.companyId, payload: { reportId, number: row.number, what: 'REPORTER' } })
            },
          },
        ]
      }
      case 'USER': {
        if (person.erased) return [kept('User', person.recordId, 'ALREADY_ERASED')]
        const userId = person.recordId
        return [
          {
            recordType: 'User',
            recordId: userId,
            method: 'ANONYMISED',
            erasedFields: columnsOf('User'),
            keptFields: [],
            why: null,
            async apply({ tx, now: at }) {
              await tx.user.update({ where: { id: userId }, data: { displayName: ERASED_NAME, email: erasedEmailOf(userId), version: { increment: 1 }, updatedAt: at }, select: { id: true } })
            },
          },
        ]
      }
      case 'WORKER': {
        const planned: PlannedRecord[] = []
        const employee = person.employeeId ? await db.employee.findUnique({ where: { id: person.employeeId }, select: { id: true } }) : null
        const hold = await ownHold(db, person, now)
        if (person.erased) planned.push(...(employee ? [kept('Employee', employee.id, 'ALREADY_ERASED')] : []), ...person.workerIds.map((id) => kept('Worker', id, 'ALREADY_ERASED')))
        else if (hold) planned.push(...(employee ? [kept('Employee', employee.id, hold, columnsOf('Employee'))] : []), ...person.workerIds.map((id) => kept('Worker', id, hold, ['displayName'])))
        else {
          if (employee) {
            const employeeId = employee.id
            planned.push({
              recordType: 'Employee',
              recordId: employeeId,
              method: 'ANONYMISED',
              erasedFields: columnsOf('Employee'),
              keptFields: [],
              why: null,
              async apply({ tx, now: at }) {
                await tx.employee.update({ where: { id: employeeId }, data: { firstName: ERASED_NAME, lastName: ERASED_NAME, displayName: ERASED_NAME, version: { increment: 1 }, updatedAt: at }, select: { id: true } })
              },
            })
          }
          for (const workerId of person.workerIds) {
            planned.push({
              recordType: 'Worker',
              recordId: workerId,
              method: 'ANONYMISED',
              erasedFields: columnsOf('Worker'),
              keptFields: [],
              why: null,
              async apply({ tx, now: at }) {
                await tx.worker.update({ where: { id: workerId }, data: { displayName: ERASED_NAME, pinHash: null, version: { increment: 1 }, updatedAt: at }, select: { id: true } })
              },
            })
          }
        }
        return planned
      }
    }
  },
}
