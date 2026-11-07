import { can } from '@nexus/factory-domain/core/permissions'
import type { AttentionCandidate } from '@nexus/factory-domain/insights/attention'
import { supplierChangeWords, supplierDocumentWords } from '@nexus/factory-domain/insights/words'
import { documentStateOf } from '@nexus/factory-domain/purchasing/portal-profile/documents'
import { SUPPLIER_CHANGES_DECIDE, SUPPLIER_DOCUMENTS_REVIEW } from '@nexus/factory-domain/purchasing/portal-profile/permissions'
import { LOOK_BACK_DAYS, recentRequests, recentUploads } from '../../purchasing/portal-profile/store'
import { capped, partyNames, SOURCE_LIMIT, type Source } from './common'

/**
 * What suppliers sent in the portal that waits for a person here (B-W2b-189; design home.approvals "every request that needs
 * my yes"; portal.supplier.profile "a change goes to the buyer in Home › Approvals and applies only on their yes";
 * portal.supplier.documents "a buyer or quality person accepts it"):
 *
 *   SUPPLIER_CHANGE    a change of its addresses, contacts and website, still OPEN (purchasing.supplierChanges.decide over the
 *                      request's company and the supplier); decided on the supplier's record (modules/purchasing/portal-profile
 *                      decide.ts)
 *   SUPPLIER_DOCUMENT  a document it sent that arrived and is not decided (purchasing.supplierDocuments.review); accepted or
 *                      refused on the supplier's record (review.ts)
 *
 * Both read their own tables (W2b schema wave 23: PartyChangeRequest, SupplierDocumentUpload; purchasing/portal-profile
 * store.ts): every request still OPEN and every upload still WAITING, whatever its age, oldest first.
 */

const DAY_MS = 86_400_000

export const supplierChange: Source = async ({ caller, viewer }) =>
  caller.withClient(async (db) => {
    const open = (await recentRequests(db, new Date(viewer.now.getTime() - LOOK_BACK_DAYS * DAY_MS)))
      .filter((entry) => entry.state === 'OPEN' && can(viewer.actor, SUPPLIER_CHANGES_DECIDE, { companyId: entry.companyId, partyId: entry.partyId }))
      .sort((a, b) => a.at.getTime() - b.at.getTime())
    const { rows, complete } = capped(open, SOURCE_LIMIT)
    const names = await partyNames(db, rows.map((row) => row.partyId))
    const codes = new Map((rows.length === 0 ? [] : await db.party.findMany({ where: { id: { in: [...new Set(rows.map((row) => row.partyId))] } }, select: { id: true, code: true } })).map((row) => [row.id, row.code] as const))
    const candidates: AttentionCandidate[] = rows.map((row) => ({
      kind: 'SUPPLIER_CHANGE',
      state: 'WAITING',
      severity: 'MEDIUM',
      record: { type: 'Party', id: row.partyId, label: codes.get(row.partyId) ?? '' },
      scope: { companyId: row.companyId, siteId: null, partyId: row.partyId },
      ...supplierChangeWords({
        supplier: names.get(row.partyId) ?? 'A supplier',
        addresses: row.changes.filter((change) => change.target === 'ADDRESS').length,
        contacts: row.changes.filter((change) => change.target === 'CONTACT').length,
        // B-W2b-F15: a change of the website (B-W2b-F13a's COMPANY target) is named, not read as "addresses: 0, contacts: 0".
        website: row.changes.some((change) => change.target === 'COMPANY'),
      }),
      due: null,
      since: row.at,
      // One row per request (a supplier may wait for two).
      subKey: row.requestId,
    }))
    return { kind: 'SUPPLIER_CHANGE', candidates, complete }
  })

export const supplierDocument: Source = async ({ caller, viewer }) =>
  caller.withClient(async (db) => {
    const uploads = (await recentUploads(db, new Date(viewer.now.getTime() - LOOK_BACK_DAYS * DAY_MS))).filter(
      (entry) => entry.decision === null && can(viewer.actor, SUPPLIER_DOCUMENTS_REVIEW, { companyId: entry.companyId, partyId: entry.partyId }),
    )
    const files = new Map(
      (uploads.length === 0 ? [] : await db.storedFile.findMany({ where: { id: { in: uploads.map((entry) => entry.fileId) } }, select: { id: true, status: true, quarantineReason: true, originalName: true } })).map((row) => [row.id, row] as const),
    )
    const waiting = uploads.filter((entry) => {
      const file = files.get(entry.fileId)
      return file !== undefined && documentStateOf({ status: file.status, quarantineReason: file.quarantineReason, decision: null, expiresOn: null, today: '2000-01-01' }) === 'WAITING'
    })
    const { rows, complete } = capped(waiting, SOURCE_LIMIT)
    const names = await partyNames(db, rows.map((row) => row.partyId))
    const codes = new Map((rows.length === 0 ? [] : await db.party.findMany({ where: { id: { in: [...new Set(rows.map((row) => row.partyId))] } }, select: { id: true, code: true } })).map((row) => [row.id, row.code] as const))
    const candidates: AttentionCandidate[] = rows.map((row) => ({
      kind: 'SUPPLIER_DOCUMENT',
      state: 'WAITING',
      severity: 'MEDIUM',
      record: { type: 'Party', id: row.partyId, label: codes.get(row.partyId) ?? '' },
      scope: { companyId: row.companyId, siteId: null, partyId: row.partyId },
      ...supplierDocumentWords({ supplier: names.get(row.partyId) ?? 'A supplier', name: files.get(row.fileId)?.originalName ?? 'a document' }),
      due: null,
      since: row.at,
      // One row per document.
      subKey: row.fileId,
    }))
    return { kind: 'SUPPLIER_DOCUMENT', candidates, complete }
  })
