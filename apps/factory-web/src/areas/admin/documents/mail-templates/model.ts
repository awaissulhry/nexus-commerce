import { reachOf, type Reach } from '../../kit/bulk-model'
import type { CompanyChoice, ListNotice, ListRead } from '../doc-templates/model'
// th-backend-g step 3 (B-TH-098's web half): a row per event and message language (it, en, de, fr, es).
import { isDraftedLanguage, type MessageLanguage } from '@nexus/factory-domain/templates/message-languages'
import type { EmailTemplate, EmailTemplatesAnswer, MailEvent, MailEventsAnswer, MailSlot } from './api'

/**
 * Admin › Documents › E-mail templates (B-W2b-432; design admin.documents sec:mail-templates, PLT-232): one row per event and
 * language — what the company's mail is sent with now (its own version, every company's, or the code's words), the subject
 * it goes out with, the open drafts, the last change —, a row opening the version that decides it, and the bulk actions
 * (publish the drafts the person may write, delete them, put the company's own version back to the default). Pure.
 */

export interface MailRow {
  /** `service.status_changed:it`. */
  id: string
  event: MailEvent
  language: MessageLanguage
  slot: MailSlot
  companyActive: EmailTemplate | null
  companyDraft: EmailTemplate | null
  allActive: EmailTemplate | null
  allDraft: EmailTemplate | null
  /** The subject the mail goes out with now (the version in use, else the code's words). */
  subject: string | null
  /**
   * th-backend-g step 3: the mail goes with the code's German, French or Spanish words — Claude's draft — and nobody has read that
   * language once yet ("Draft — to be read once"): until then a mail Nexus sends by itself goes in English.
   */
  unread: boolean
}

/** th-backend-g step 3: a drafted language nobody read yet (the events answer's `review`; absent: read, as an answer of before). */
export const languageUnread = (language: string, review: MailEventsAnswer['review']): boolean => isDraftedLanguage(language) && review !== undefined && review[language].readBy === null

export type MailBulk = 'publish' | 'retire' | 'delete'

export interface MailTemplatesModel {
  prefix: string
  companies: readonly CompanyChoice[]
  companyId: string | null
  read: ListRead<{ list: EmailTemplatesAnswer; events: MailEventsAnswer }>
  selected?: readonly string[]
  confirm?: { action: MailBulk; rows: readonly MailRow[] } | null
  busy?: boolean
  notice?: ListNotice | null
  asOf?: string | null
  updates?: number
}

export const mailRowId = (event: string, language: string) => `${event}:${language}`

export function mailRowsOf(answer: { list: EmailTemplatesAnswer; events: MailEventsAnswer } | null): MailRow[] {
  if (!answer) return []
  const byId = new Map(answer.list.templates.map((template) => [template.id, template]))
  const pick = (version: { id: string } | null) => (version ? (byId.get(version.id) ?? null) : null)
  return answer.list.slots.map((slot) => {
    const companyActive = pick(slot.company.active)
    const allActive = pick(slot.all.active)
    const event = answer.events.events.find((one) => one.event === slot.event)
    // th-backend-g step 3: German, French and Spanish read the code's drafts.
    const code = (isDraftedLanguage(slot.language) ? event?.drafts?.[slot.language] : event?.words[slot.language]) ?? null
    const subject = slot.inUse === 'COMPANY' ? (companyActive?.subject ?? null) : slot.inUse === 'ALL' ? (allActive?.subject ?? null) : (code?.subject ?? null)
    const unread = slot.inUse === 'CODE' && languageUnread(slot.language, answer.events.review)
    return { id: mailRowId(slot.event, slot.language), event: slot.event, language: slot.language, slot, companyActive, companyDraft: pick(slot.company.draft), allActive, allDraft: pick(slot.all.draft), subject, unread }
  })
}

/** The version a row opens: the company's draft, its own in use, then every company's draft and in use; null: the code's words only. */
export const mailOpenTarget = (row: Pick<MailRow, 'slot'>): string | null => row.slot.company.draft?.id ?? row.slot.company.active?.id ?? row.slot.all.draft?.id ?? row.slot.all.active?.id ?? null

/** The drafts of a row the person may publish or delete (every company's only with a grant over every company). */
export function draftsOf(row: Pick<MailRow, 'companyDraft' | 'allDraft'>, may: { company: boolean; all: boolean }): EmailTemplate[] {
  return [may.company ? row.companyDraft : null, may.all ? row.allDraft : null].filter((draft): draft is EmailTemplate => draft !== null)
}

export function mailRowHeld(row: MailRow, may: { company: boolean; all: boolean }): string | null {
  if (!may.company && !may.all) return 'tpl.held.noRight'
  if (draftsOf(row, may).length === 0 && !(may.company && row.companyActive)) return 'tpl.list.nothingToDo'
  return null
}

export function mailBulkReach(rows: readonly MailRow[], action: MailBulk, may: { company: boolean; all: boolean }): Reach<MailRow> {
  return reachOf(rows, (row) => {
    if (action === 'retire') return may.company && row.companyActive ? null : 'tpl.bulk.left.noOwn'
    return draftsOf(row, may).length > 0 ? null : 'tpl.bulk.left.noDraft'
  })
}

/** Which "write" a row offers: the company's first version, every company's first version (each only while it has none). */
export function mailStarts(row: Pick<MailRow, 'slot'>, may: { company: boolean; all: boolean }): Array<'company' | 'all'> {
  const starts: Array<'company' | 'all'> = []
  if (may.company && !row.slot.company.active && !row.slot.company.draft) starts.push('company')
  if (may.all && !row.slot.all.active && !row.slot.all.draft) starts.push('all')
  return starts
}
