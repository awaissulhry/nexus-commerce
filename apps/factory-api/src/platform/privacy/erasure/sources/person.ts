import { ERASED_NAME } from '@nexus/factory-domain/privacy/retention/erasure'
import { ERASED_PERSON_WORDS, type DataSubjectKind } from '@nexus/factory-domain/privacy/retention/requests'
import type { PersonFacts, Reader } from './type'

/**
 * The person a request names, read in the caller's scope (B-W2b-405): null when the record is not there (or not visible). The
 * database already refused a request naming a missing record or another company's; this reads what the sources need.
 */

const ERASED = ERASED_PERSON_WORDS.en
const base = { partyId: null, partyIsPerson: false, employeeId: null, workerIds: [] as string[], userId: null, blocked: null }

export async function personFacts(db: Reader, kind: DataSubjectKind, recordType: string, recordId: string): Promise<PersonFacts | null> {
  switch (kind) {
    case 'CONTACT': {
      const row = await db.partyContact.findUnique({ where: { id: recordId }, select: { id: true, partyId: true, name: true, email: true, erasedAt: true, party: { select: { companyId: true, kind: true } } } })
      if (!row) return null
      const portal = row.email ? await db.user.findFirst({ where: { partyId: row.partyId, email: { equals: row.email, mode: 'insensitive' }, status: { in: ['INVITED', 'ACTIVE', 'SUSPENDED'] } }, select: { id: true } }) : null
      return {
        ...base,
        kind,
        recordType,
        recordId,
        name: row.erasedAt ? ERASED : row.name,
        erased: row.erasedAt !== null,
        companyId: row.party.companyId,
        email: row.email,
        partyId: row.partyId,
        partyIsPerson: row.party.kind === 'PERSON',
        blocked: portal ? 'PORTAL_USER' : null,
      }
    }
    case 'PROSPECT': {
      const row = await db.inquiry.findUnique({ where: { id: recordId }, select: { id: true, companyId: true, number: true, contactId: true, prospectName: true, prospectCompany: true, prospectEmail: true, prospectPhone: true, prospectErasedAt: true } })
      if (!row) return null
      const named = [row.prospectName, row.prospectCompany, row.prospectEmail, row.prospectPhone].some((value) => value !== null)
      return {
        ...base,
        kind,
        recordType,
        recordId,
        name: row.prospectErasedAt ? ERASED : (row.prospectName ?? row.prospectEmail ?? row.prospectCompany ?? `Prospect of ${row.number}`),
        erased: row.prospectErasedAt !== null,
        companyId: row.companyId,
        email: row.prospectEmail,
        blocked: !named && row.prospectErasedAt === null && row.contactId !== null ? 'NOT_A_PROSPECT' : null,
      }
    }
    case 'REPORTER': {
      const row = await db.productSafetyReport.findUnique({ where: { id: recordId }, select: { id: true, companyId: true, number: true, reporterName: true, reporterEmail: true, reporterPhone: true } })
      if (!row) return null
      const erased = row.reporterName === null && row.reporterEmail === null && row.reporterPhone === null
      return { ...base, kind, recordType, recordId, name: erased ? ERASED : (row.reporterName ?? row.reporterEmail ?? `Reporter of ${row.number}`), erased, companyId: row.companyId, email: row.reporterEmail }
    }
    case 'USER': {
      const row = await db.user.findUnique({ where: { id: recordId }, select: { id: true, displayName: true, email: true, status: true } })
      if (!row) return null
      const erased = row.displayName === ERASED_NAME && row.email.endsWith('@erased.invalid')
      return { ...base, kind, recordType, recordId, name: erased ? ERASED : row.displayName, erased, companyId: null, email: erased ? null : row.email, userId: row.id, blocked: row.status === 'DEACTIVATED' ? null : 'ACCOUNT_OPEN' }
    }
    case 'WORKER': {
      const worker = recordType === 'Worker' ? await db.worker.findUnique({ where: { id: recordId }, select: { id: true, employeeId: true } }) : null
      const employeeId = recordType === 'Employee' ? recordId : (worker?.employeeId ?? null)
      const employee = employeeId ? await db.employee.findUnique({ where: { id: employeeId }, select: { id: true, companyId: true, displayName: true, status: true, userId: true } }) : null
      const workers = employee ? await db.worker.findMany({ where: { employeeId: employee.id }, select: { id: true, companyId: true, displayName: true, status: true, userId: true } }) : worker ? await db.worker.findMany({ where: { id: worker.id }, select: { id: true, companyId: true, displayName: true, status: true, userId: true } }) : []
      if (!employee && workers.length === 0) return null
      const name = employee?.displayName ?? workers[0]!.displayName
      const active = employee?.status === 'ACTIVE' || workers.some((row) => row.status === 'ACTIVE')
      return {
        ...base,
        kind,
        recordType,
        recordId,
        name: name === ERASED_NAME ? ERASED : name,
        erased: name === ERASED_NAME,
        companyId: employee?.companyId ?? workers[0]!.companyId,
        email: null,
        employeeId: employee?.id ?? null,
        workerIds: workers.map((row) => row.id),
        userId: employee?.userId ?? workers.find((row) => row.userId !== null)?.userId ?? null,
        blocked: active ? 'STILL_ACTIVE' : null,
      }
    }
  }
}
