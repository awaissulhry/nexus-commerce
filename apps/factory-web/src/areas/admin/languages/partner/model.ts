import { recipientLanguageOf } from '@nexus/factory-domain/templates/language'
import { reachOf, type Reach } from '../../kit/bulk-model'
import type { Said } from '../../documents/template-editor/model'
import type { ContactLanguage } from './api'

/**
 * Admin › Languages › per partner contact (B-W2b-432; design admin.languages sec:documents "per partner contact (W2b)";
 * PLT-131): every active partner contact with the language its documents and mails go out in and why (its own, its
 * party's, the company's; a language we do not write goes out in English, said with the one they read), its own language
 * changed in the row or for the selected rows at once (one write per contact, each at the version read). Pure.
 */

/** What a contact's own language may be set to: Italian, English, or none (its party's). */
export const OWN_CHOICES = ['', 'it', 'en'] as const
export type OwnChoice = (typeof OWN_CHOICES)[number]

export type PartnerRead = { status: 'loading' } | { status: 'failed'; problem: string } | { status: 'ready'; contacts: readonly ContactLanguage[]; nextCursor: string | null; more: boolean }

export interface PartnerNotice extends Said {
  tone: 'success' | 'info' | 'warning' | 'danger'
  refused?: ReadonlyArray<{ id: string; said: Said }>
}

export interface PartnerModel {
  /** `/w/<company>`. */
  prefix: string
  /** parties.view: without it the part says what it needs (the administrator template does not hold it). */
  canView: boolean
  /** parties.manage: change a contact's language. */
  canManage: boolean
  read: PartnerRead
  query: string
  selected?: readonly string[]
  /** Rows being written (ids). */
  saving?: readonly string[]
  notice?: PartnerNotice | null
  /** Reading the next page. */
  loadingMore?: boolean
}

/** The row after its own language changed: the language it now goes out in, worked out as the API does. */
export function withOwn(row: ContactLanguage, own: string | null, version: number): ContactLanguage {
  const out = recipientLanguageOf({ contact: own, party: row.party.language })
  return { ...row, own, version, language: out.language, source: out.source, notOffered: out.notOffered }
}

/** The row's own language as a choice of the select ('' = its party's); another language it keeps stays as it is. */
export const ownChoice = (row: Pick<ContactLanguage, 'own'>): string => row.own ?? ''

/** Which selected rows a "set to" reaches: those whose own language is not that one already. */
export function setReach(rows: readonly ContactLanguage[], to: OwnChoice): Reach<ContactLanguage> {
  return reachOf(rows, (row) => ((row.own ?? '') === to ? 'tpl.partner.left.already' : null))
}

/** Why the language of a row (or of the selected rows) cannot be changed now; null when it can. */
export function changeHeld(model: Pick<PartnerModel, 'canManage'>, busy: boolean): string | null {
  if (!model.canManage) return 'tpl.partner.held.manage'
  if (busy) return 'tpl.held.busy'
  return null
}

/** "German" / "tedesco": a language code in the reader's words (Intl), else the code itself. */
export function languageName(code: string, locale: string): string {
  try {
    return new Intl.DisplayNames([locale], { type: 'language' }).of(code) ?? code
  } catch {
    return code
  }
}
