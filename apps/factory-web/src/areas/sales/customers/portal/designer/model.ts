import { DESIGNER_REFUSALS, DESIGNER_WORDS, type DesignerRefusal } from '@nexus/factory-domain/auth/partners/designer'
import { isApiError, issuePath } from '../../../../../lib/api/errors'
import type { DesignerChoices, DesignerPerson, DesignerSlot } from './api'

/**
 * F-CP-155 (customer page plan C7, D12; design 10 §7, picture 23; lead pick: no step-up; the API's B-CP-078) — the factory designer
 * and its backup on the customer's card "Who looks after {customer}", pure: the rows' tags ("{customer} sees this name", "No longer
 * reaches {customer}", "No longer active"), what the portal names now, why Change… is held (in words), the ONE Change… window's
 * choices (eligible office people only — never anyone of another customer), its own checks before Apply (the backup only beside a
 * designer, never the same person), the body with the stored version, and a refusal at its field in the card's words.
 * Words: parties.json `customers.designer.*` (office "tu").
 */

export interface Phrase {
  readonly key: string
  readonly params?: Readonly<Record<string, string | number>>
  /** The partners screens' catalogue (`portal-access`: a right the reader lacks, said "Needs the right: …"); else parties. */
  readonly ns?: 'portal-access'
}

export type DesignerRead = { readonly status: 'loading' } | { readonly status: 'ready'; readonly slot: DesignerSlot } | { readonly status: 'error'; readonly key: string }
export type ChoicesRead = { readonly status: 'loading' } | { readonly status: 'ready'; readonly choices: DesignerChoices } | { readonly status: 'error'; readonly key: string }

export interface DesignerDraft {
  readonly designerId: string | null
  readonly backupId: string | null
}

export interface DesignerDialog {
  readonly draft: DesignerDraft
  readonly choices: ChoicesRead
  readonly busy: boolean
  /** A refusal at its field (`designerId`, `backupId`). */
  readonly fields: Readonly<Partial<Record<keyof DesignerDraft, Phrase>>>
  /** ONE banner in the window (changed meanwhile, nothing changes, a fault). */
  readonly problem: Phrase | null
}

export interface DesignerModel {
  readonly read: DesignerRead
  /** The reader holds partners.manage at all (else Change… is held: the right it needs). */
  readonly manage: boolean
  readonly dialog: DesignerDialog | null
  /** A receipt after Apply. */
  readonly notice: Phrase | null
}

export interface DesignerActions {
  readonly onChange?: () => void
  readonly onDraft?: (patch: Partial<DesignerDraft>) => void
  readonly onApply?: () => void
  readonly onClose?: () => void
  readonly onRetry?: () => void
  readonly onRetryChoices?: () => void
  readonly onDismissNotice?: () => void
}

/** A named person's tag: the customer sees this name; or why the portal no longer names them (they stay named until changed). */
export function personTagOf(person: Pick<DesignerPerson, 'state'>): { readonly tone: 'info' | 'warning'; readonly words: Phrase } {
  if (person.state === 'NO_REACH') return { tone: 'warning', words: { key: 'customers.designer.lostReach' } }
  if (person.state === 'NOT_ACTIVE') return { tone: 'warning', words: { key: 'customers.designer.notActive' } }
  return { tone: 'info', words: { key: 'customers.designer.seen' } }
}

/** The line under the rows: the portal is off; else what the portal names now (the designer, the backup instead, or nobody). */
export function portalLineOf(slot: Pick<DesignerSlot, 'portalOn' | 'designer' | 'backup'>): Phrase {
  if (!slot.portalOn) return { key: 'customers.designer.portalOff' }
  if (slot.designer && slot.designer.state !== 'OK') {
    if (slot.backup?.state === 'OK') return { key: 'customers.designer.backupNamed', params: { name: slot.backup.name } }
    return { key: 'customers.designer.nobodyNamed' }
  }
  return { key: 'customers.designer.hint' }
}

/** Why Change… is held now (null: it opens): no partners.manage at all, or not over every company the customer works with. */
export function changeHeldOf(manage: boolean, read: DesignerRead): Phrase | null {
  if (!manage) return { key: 'right.manage', ns: 'portal-access' } // "Needs the right: …" (the partners screens' own words)
  if (read.status !== 'ready') return { key: 'customers.designer.reading' }
  return read.slot.mayManage ? null : { key: 'customers.designer.heldEveryCompany' }
}

/** The window starts from the slot as stored. */
export const designerDraftOf = (slot: Pick<DesignerSlot, 'designer' | 'backup'>): DesignerDraft => ({ designerId: slot.designer?.id ?? null, backupId: slot.backup?.id ?? null })

/** A pick list's options: the eligible people (Me marked), and a person named now who is no longer on it (said so). */
export function choicesOf(choices: DesignerChoices, named: DesignerPerson | null, without: string | null): Array<{ readonly value: string; readonly label: Phrase | string }> {
  const listed = choices.people.filter((person) => person.id !== without).map((person) => ({ value: person.id, label: person.me ? { key: 'customers.designer.me', params: { name: person.name } } : person.name }))
  if (named && named.id !== without && !choices.people.some((person) => person.id === named.id)) listed.unshift({ value: named.id, label: { key: 'customers.designer.notListed', params: { name: named.name } } })
  return listed
}

/** The window's own checks before Apply (the API checks again): the backup only beside a designer, never the same person. */
export function draftProblems(draft: DesignerDraft): Partial<Record<keyof DesignerDraft, Phrase>> {
  if (draft.backupId === null) return {}
  if (draft.designerId === null) return { backupId: { key: 'customers.designer.refusal.BACKUP_ALONE' } }
  return draft.backupId === draft.designerId ? { backupId: { key: 'customers.designer.refusal.SAME_PERSON' } } : {}
}

/** Nothing to apply: the draft names who is named already. */
export const sameAsSlot = (draft: DesignerDraft, slot: Pick<DesignerSlot, 'designer' | 'backup'>): boolean => draft.designerId === (slot.designer?.id ?? null) && draft.backupId === (slot.backup?.id ?? null)

/** Why Apply is held (null: it applies): saving, the pick list still read, nothing changes, a field to fix. */
export function applyHeldOf(dialog: DesignerDialog, slot: Pick<DesignerSlot, 'designer' | 'backup'>): Phrase | null {
  if (dialog.busy) return { key: 'customers.designer.saving' }
  if (dialog.choices.status === 'loading') return { key: 'customers.designer.reading' }
  if (sameAsSlot(dialog.draft, slot)) return { key: 'customers.designer.nothing' }
  if (Object.keys(draftProblems(dialog.draft)).length > 0) return { key: 'customers.designer.fixFirst' }
  return null
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** The API's English refusal words → their code (the customer's name in them may be any spelling of it). */
const REFUSAL_OF: ReadonlyArray<readonly [RegExp, DesignerRefusal]> = DESIGNER_REFUSALS.map((code) => [new RegExp(`^${escape(DESIGNER_WORDS[code].en).replace(escape('{customer}'), '.+')}$`), code] as const)

/** A refused Apply: at its field (NOT_OFFICE · NOT_ACTIVE · NO_REACH · BACKUP_ALONE · SAME_PERSON), or ONE line (and read again). */
export function designerRefusalOf(error: unknown): { readonly fields: Partial<Record<keyof DesignerDraft, Phrase>>; readonly problem: Phrase | null; readonly reread: boolean } {
  if (!isApiError(error)) return { fields: {}, problem: { key: 'customers.designer.failed' }, reread: false }
  if (error.kind === 'invalid') {
    const fields: Partial<Record<keyof DesignerDraft, Phrase>> = {}
    for (const issue of error.issues) {
      const field = issuePath(issue).split(/[./]/).pop()
      if (field !== 'designerId' && field !== 'backupId') continue
      const code = REFUSAL_OF.find(([pattern]) => pattern.test(issue.message ?? ''))?.[1]
      fields[field] ??= { key: code ? `customers.designer.refusal.${code}` : 'customers.designer.refusal.other' }
    }
    return Object.keys(fields).length > 0 ? { fields, problem: null, reread: false } : { fields: {}, problem: { key: 'customers.designer.failed' }, reread: false }
  }
  if (error.kind === 'conflict') {
    const moved = error.issues.some((issue) => issuePath(issue).split(/[./]/).includes('version'))
    return { fields: {}, problem: { key: moved ? 'customers.designer.stale' : 'customers.designer.nothing' }, reread: true }
  }
  if (error.kind === 'not_found') return { fields: {}, problem: { key: 'customers.designer.notFound' }, reread: false }
  if (error.kind === 'forbidden') return { fields: {}, problem: { key: 'customers.designer.heldEveryCompany' }, reread: true }
  return { fields: {}, problem: { key: 'customers.designer.failed' }, reread: false }
}
