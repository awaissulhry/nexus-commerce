import { phraseMatches } from '@nexus/ui/components'
import type { ErasurePreview, ErasureGroup } from './api'
import type { Read } from '../model'

/**
 * Anonymise …?, pure (B-W2b-414; design admin.privacy pop:erase "What is erased, what stays because the law requires it, the
 * decision is logged. Typed name."): the preview's groups in the order a person reads them (erased, deleted, kept with why),
 * each record type and column in the page's words, and why the Anonymise button is held.
 */

/** The record types an erasure looks at (B-W2b-405's sources), each worded `dp.erase.type.<Type>`; any other: "Other records". */
export const ERASURE_TYPES = [
  'PartyContact',
  'Party',
  'Inquiry',
  'ProductSafetyReport',
  'User',
  'Employee',
  'Worker',
  'CustomFieldValue',
  'MeasurementProfile',
  'WorkerNoticeAck',
  'StaffNoticeAck',
  'Message',
  'InboundEmail',
  'EmailOutbound',
  'AuditLog',
] as const

/** The columns the sources name, each worded `dp.erase.field.<name>`; any other: "other details". */
export const ERASURE_FIELDS = [
  'name',
  'email',
  'phone',
  'prospectName',
  'prospectCompany',
  'prospectEmail',
  'prospectPhone',
  'prospectLawfulBasis',
  'reporterName',
  'reporterEmail',
  'reporterPhone',
  'displayName',
  'firstName',
  'lastName',
  'pinHash',
  'legalName',
  'tradeName',
  'riderName',
  'measurements',
  'fitNotes',
  'authorName',
  'bodyText',
  'bodyHtml',
  'fromAddress',
  'fromName',
  'subject',
  'to',
  'cc',
  'before',
  'after',
] as const

const KNOWN_TYPES: ReadonlySet<string> = new Set(ERASURE_TYPES)
const KNOWN_FIELDS: ReadonlySet<string> = new Set(ERASURE_FIELDS)

export const typeKey = (recordType: string) => (KNOWN_TYPES.has(recordType) ? `dp.erase.type.${recordType}` : 'dp.erase.type.other')

/** The columns in the page's words, each once (an unknown column is said as "other details", never by its name). */
export function fieldKeys(fields: readonly string[]): string[] {
  const keys = fields.map((field) => (KNOWN_FIELDS.has(field) ? `dp.erase.field.${field}` : 'dp.erase.field.other'))
  return [...new Set(keys)]
}

export type EraseSection = 'anonymised' | 'deleted' | 'kept'
export const ERASE_SECTIONS: readonly EraseSection[] = ['anonymised', 'deleted', 'kept']

/** The preview's groups by section, the largest first inside each. */
export function sectionsOf(preview: ErasurePreview): { section: EraseSection; groups: ErasureGroup[] }[] {
  return ERASE_SECTIONS.map((section) => ({ section, groups: [...preview[section]].sort((a, b) => b.count - a.count || a.recordType.localeCompare(b.recordType)) })).filter((entry) => entry.groups.length > 0)
}

export interface EraseModel {
  requestId: string
  version: number
  /** The preview (GET …/erasure). */
  preview: Read<ErasurePreview>
  reason: string
  typed: string
  busy: boolean
  problem: string | null
  /** After the erasure: what it did. */
  done: { anonymised: number; deleted: number; kept: number } | null
}

/** Why Anonymise is held (a key), or null when it may run. */
export function eraseHeld(model: EraseModel, canErase: boolean): string | null {
  const preview = model.preview.value
  if (!canErase) return 'dp.req.held.erase'
  if (!preview) return 'dp.erase.held.loading'
  if (preview.blocked) return `dp.erase.blocked.${preview.blocked.code}`
  if (!preview.action.allowed) return preview.action.held ? `dp.held.${preview.action.held.code}` : 'dp.erase.held.loading'
  if (preview.anonymised.length === 0 && preview.deleted.length === 0) return 'dp.erase.held.nothing'
  if (model.reason.trim().length < 3) return 'dp.erase.held.reason'
  if (model.reason.trim().length > 1000) return 'dp.erase.held.reasonLong'
  if (!phraseMatches(model.typed, preview.person.name)) return 'dp.erase.held.typed'
  return null
}
