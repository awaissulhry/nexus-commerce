/**
 * Publish status — the ONE vocabulary for what became of a publish (sheet publish parity, 2026-10-02).
 *
 * Read by the "Last publish" sheet cell, the sheet toolbar chip, the Publish dialog, the publish history and the
 * products list. A surface that writes its own `status === 'FAILED' ? 'danger' : …` has invented a second answer to
 * the same question, so every label, tone and hint lives here.
 *
 * Two levels, deliberately not mapped onto each other:
 *  - **Publication** — one publish to one destination (`StudioPublishResult.status`, plus NOT_SENT for a publish that
 *    a check stopped before anything left Nexus).
 *  - **Per-SKU result** — one product inside a publication. WAITING / SKIPPED / UNKNOWN exist only here.
 *
 * Honesty rules (the Owner's "100% honest UI"):
 *  - Only VERIFIED is the success tone, and only VERIFIED carries a check glyph. ACCEPTED means the channel took the
 *    request; it does not mean buyers can see it. The DS success pill is blue (H10 parity), close to the info pill, so
 *    the glyph — not the colour — is what tells Verified from Accepted at a glance (measured 2026-10-02 review).
 *  - The word always carries the meaning; the tone repeats it and is never the only signal.
 *  - An unknown status is shown as itself, neutral — never guessed into a known one.
 *
 * Also: `publishCellModel` (pure) turns one row's publish facts into what the cell and its card draw, so the cell,
 * the catalog and the tests share one rule. Pure — no React.
 */
import type { Tone } from '../../primitives/tone'
import { EMPTY_DASH, ago } from './format'

export interface PublishStatusMeta {
  label: string
  tone: Tone
  /** One plain-English sentence for a tooltip or a screen reader. */
  hint: string
  /** True when the status will not change by itself any more. */
  terminal: boolean
  /** `check` = draw a check glyph instead of the dot (VERIFIED only). Use `PublishStatusPill`, never a hand-rolled pill. */
  glyph?: 'check'
  /**
   * The sentence for INSIDE the details (the card, the history drawer), where `hint`'s "Open the details to see why"
   * would point at the place the reader already is. Absent = `hint` reads right everywhere.
   */
  detailHint?: string
}

export const PUBLICATION_STATUSES = ['QUEUED', 'PUBLISHING', 'SUBMITTED', 'ACCEPTED', 'VERIFIED', 'PARTIAL', 'FAILED', 'NOT_SENT', 'UNVERIFIED', 'CANCELLED'] as const
export type PublicationStatus = (typeof PUBLICATION_STATUSES)[number]

export const PUBLISH_RESULT_STATUSES = ['ACCEPTED', 'VERIFIED', 'FAILED', 'WAITING', 'NOT_SENT', 'SKIPPED', 'UNKNOWN'] as const
export type PublishResultStatus = (typeof PUBLISH_RESULT_STATUSES)[number]

const PUBLICATION: Record<PublicationStatus, PublishStatusMeta> = {
  // A destination of a publish batch that has not had its turn yet (sheet publish parity step 5/6). Nothing left Nexus.
  QUEUED: { label: 'Waiting its turn', tone: 'neutral', terminal: false, hint: 'Nexus sends this after the destinations before it. Nothing has been sent yet.' },
  PUBLISHING: { label: 'Sending', tone: 'info', terminal: false, hint: 'Nexus is sending this to the channel.' },
  SUBMITTED: { label: 'Waiting for channel', tone: 'info', terminal: false, hint: 'The channel received it and is still processing.' },
  ACCEPTED: { label: 'Accepted', tone: 'info', terminal: true, hint: 'The channel accepted it. The channel decides when buyers can see it.' },
  VERIFIED: { label: 'Verified', tone: 'success', terminal: true, glyph: 'check', hint: 'The channel accepted it, and Nexus read the listing back.' },
  PARTIAL: {
    label: 'Partly failed', tone: 'warning', terminal: true,
    hint: 'Some products failed. Open the details to see why.', detailHint: 'Some products in this publish failed.',
  },
  FAILED: {
    label: 'Failed', tone: 'danger', terminal: true,
    hint: 'The channel refused it. Open the details to see why.', detailHint: 'The channel refused this publish.',
  },
  NOT_SENT: { label: 'Not sent', tone: 'danger', terminal: true, hint: 'A check failed before sending. Nothing changed on the channel.' },
  UNVERIFIED: {
    label: 'Result unknown', tone: 'warning', terminal: false,
    hint: 'The channel did not answer within 30 minutes. It may have arrived. Check the status before you publish again.',
  },
  // A batch destination the person cancelled before its turn.
  CANCELLED: { label: 'Cancelled', tone: 'neutral', terminal: true, hint: 'The publish was cancelled before this destination’s turn. Nothing was sent to it.' },
}

const RESULT: Record<PublishResultStatus, PublishStatusMeta> = {
  ACCEPTED: { label: 'Accepted', tone: 'info', terminal: true, hint: 'The channel accepted this product. The channel decides when buyers can see it.' },
  VERIFIED: { label: 'Verified', tone: 'success', terminal: true, glyph: 'check', hint: 'The channel accepted this product, and Nexus read it back.' },
  FAILED: { label: 'Failed', tone: 'danger', terminal: true, hint: 'The channel refused this product. Its message says why.' },
  WAITING: { label: 'Waiting', tone: 'info', terminal: false, hint: 'The channel has not finished with this product yet.' },
  NOT_SENT: { label: 'Not sent', tone: 'danger', terminal: true, hint: 'A check failed before sending. Nothing changed on the channel for this product.' },
  SKIPPED: { label: 'Skipped', tone: 'neutral', terminal: true, hint: 'Not part of this publish: it was excluded, or its offer is closed.' },
  UNKNOWN: { label: 'Result unknown', tone: 'warning', terminal: false, hint: 'The channel has not said what became of this product. Check before you publish it again.' },
}

/** No publish from Nexus is recorded for this row. */
export const NO_PUBLISH: PublishStatusMeta = { label: EMPTY_DASH, tone: 'neutral', terminal: true, hint: 'Not published from Nexus yet.' }

const lookup = <K extends string>(table: Record<K, PublishStatusMeta>, raw: string | null | undefined, kind: string): PublishStatusMeta => {
  if (raw == null || raw.trim() === '') return NO_PUBLISH
  const key = raw.trim().toUpperCase()
  return Object.prototype.hasOwnProperty.call(table, key)
    ? table[key as K]
    : { label: raw.trim(), tone: 'neutral', terminal: true, hint: `Unrecognised ${kind} “${raw.trim()}”.` }
}

/** What became of one publish to one destination. */
export function publicationStatusMeta(raw: string | null | undefined): PublishStatusMeta {
  return lookup(PUBLICATION, raw, 'publish status')
}

/**
 * What became of one product inside a publish. The server's per-SKU `SUBMITTED` means the same as WAITING: the
 * channel has it and has not answered for this product yet.
 */
export function publishResultMeta(raw: string | null | undefined): PublishStatusMeta {
  const key = raw?.trim().toUpperCase()
  return lookup(RESULT, key === 'SUBMITTED' ? 'WAITING' : raw, 'product result')
}

// ── The "Last publish" cell ─────────────────────────────────────────────────────────────────────────────────────

export interface PublishIssue {
  code?: string | null
  severity: 'error' | 'warning' | 'info'
  message: string
  /** The field's name as the sheet shows it. */
  fieldLabel?: string | null
  /** The sheet column the issue belongs to, when the channel named one. "Go to field" needs it. */
  columnKey?: string | null
}

export interface PublishLast {
  publicationId: string
  status: string
  /** This row's own result inside the publication (per-SKU vocabulary), when the server has one. */
  outcome?: string | null
  /** ISO time of the publish. */
  at: string
  userName?: string | null
  /** The channel's message for this row. */
  message?: string | null
  /** Feed id, ItemID or product id on the channel. */
  reference?: string | null
  /** Names of the fields this publish sent for this row. `$create` = a complete new listing. */
  sentFields: string[]
  issues: PublishIssue[]
}

/** A family's products in one publish: how many it sent, and how many the channel refused or never received. */
export interface PublishFamilyCounts { total: number; failed: number }

/** One row's publish facts — the contract of the row-status read (PLAN item 2). */
export interface PublishStatusValue {
  /** A newer publish to this destination that has not finished yet. */
  inFlight?: { status: string } | null
  last: PublishLast | null
  /** The row was edited after `last`. */
  editedSince?: boolean
  /**
   * Set on a family's MAIN row only: how the family's products fared in `last`'s publish on this destination. With
   * failures the cell shows the count ("2 of 11 failed") in the publication's tone — a collapsed family must never
   * read "Accepted" over sizes that failed (review 2026-10-02) — and the card keeps this row's own result.
   */
  family?: PublishFamilyCounts | null
  /** "Amazon · IT", "eBay · IT · Xavia Racing". */
  destinationLabel: string
  /** The row-status read failed. The cell says so instead of showing an empty, "never published" row. */
  readError?: string | null
}

export const CREATE_FIELD = '$create'

export type PublishCellState = 'loading' | 'error' | 'never' | 'status'

export interface PublishCellModel {
  state: PublishCellState
  meta: PublishStatusMeta
  /** "12:04" today, "1 Oct" before today ("1 Oct 2025" in another year); empty when there is no time. */
  shortTime: string
  /** The trigger's whole accessible name. */
  ariaLabel: string
  /** Plain hover text for the states that open no card. */
  title: string
}

const pad = (n: number) => String(n).padStart(2, '0')
/**
 * A fixed month table, as `matrixDay` (matrixCells.ts) does and for its reason: `toLocaleDateString('en-GB')` prints
 * "Sept" under current CLDR, and the browser's locale would make the cell say "Oct 1" for one viewer and "1 Oct" for
 * another. One shape everywhere a publish time is shown: "12:04" · "1 Oct" · "1 Oct 2025" · "1 Oct, 12:04".
 */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const day = (d: Date, now: Date) => `${d.getDate()} ${MONTHS[d.getMonth()]}${d.getFullYear() === now.getFullYear() ? '' : ` ${d.getFullYear()}`}`
const clock = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`

/** "12:04" when `iso` is on `now`'s day (in the viewer's zone), otherwise "1 Oct" ("1 Oct 2025" in another year). */
export function publishShortTime(iso: string, now: number = Date.now()): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const today = new Date(now)
  const sameDay = d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate()
  return sameDay ? clock(d) : day(d, today)
}

/** "1 Oct, 12:04" ("1 Oct 2025, 12:04" in another year) — the same shape as the cell's short time, with the clock. */
export function publishFullTime(iso: string, now: number = Date.now()): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return `${day(d, new Date(now))}, ${clock(d)}`
}

/** "2 of 11 products in this family failed" — the spoken form; the card adds " in this publish.". */
const familyWords = (failed: number, total: number) => failed >= total
  ? `All ${total} products in this family failed`
  : `${failed} of ${total} products in this family failed`

/**
 * A family's main row when products of the family failed: the count as the status word ("2 of 11 failed"; "All 11
 * failed"), in the worst tone it carries — warning while some went through, danger when none did. `null` when nothing
 * failed: the publication's own word ("Verified", "Accepted") is then the whole truth.
 */
export function publishFamilyMeta(publicationStatus: string, family: PublishFamilyCounts): PublishStatusMeta | null {
  const total = Math.max(0, Math.floor(family.total))
  const failed = Math.min(total, Math.max(0, Math.floor(family.failed)))
  if (total === 0 || failed === 0) return null
  const base = publicationStatusMeta(publicationStatus)
  const sentence = `${familyWords(failed, total)} in this publish.`
  return {
    label: failed === total ? `All ${total} failed` : `${failed} of ${total} failed`,
    tone: failed === total || base.tone === 'danger' ? 'danger' : 'warning',
    terminal: base.terminal,
    hint: `${sentence} Open the details to see why.`,
    detailHint: sentence,
  }
}

/** The status the cell shows: a publish in flight wins over the last finished one. */
export function publishShownStatus(value: PublishStatusValue): PublishStatusMeta {
  if (value.inFlight) return publicationStatusMeta(value.inFlight.status)
  if (!value.last) return NO_PUBLISH
  return publicationStatusMeta(value.last.status)
}

/**
 * What a "Last publish" cell draws. `value === undefined` = the row-status read has not answered yet (a skeleton,
 * never a dash: a dash would say "never published" before anything was read).
 */
export function publishCellModel(value: PublishStatusValue | undefined, now: number = Date.now()): PublishCellModel {
  if (value === undefined) {
    return { state: 'loading', meta: NO_PUBLISH, shortTime: '', ariaLabel: 'Last publish: loading.', title: 'Loading publish results.' }
  }
  if (value.readError) {
    const meta: PublishStatusMeta = { label: EMPTY_DASH, tone: 'neutral', terminal: true, hint: 'Publish results could not be read.' }
    return { state: 'error', meta, shortTime: '', ariaLabel: `Last publish, ${value.destinationLabel}: could not be read.`, title: meta.hint }
  }
  if (!value.last && !value.inFlight) {
    return { state: 'never', meta: NO_PUBLISH, shortTime: '', ariaLabel: `Last publish, ${value.destinationLabel}: not published from Nexus yet.`, title: NO_PUBLISH.hint }
  }
  const family = !value.inFlight && value.last && value.family ? publishFamilyMeta(value.last.status, value.family) : null
  const meta = family ?? publishShownStatus(value)
  const at = value.last?.at ?? null
  const shortTime = value.inFlight || !at ? '' : publishShortTime(at, now)
  const time = !value.inFlight && at ? `, ${publishFullTime(at, now)}` : ''
  const edited = value.editedSince ? ' Edited since.' : ''
  const spoken = family && value.family ? familyWords(Math.min(value.family.failed, value.family.total), value.family.total) : meta.label
  return {
    state: 'status', meta, shortTime,
    ariaLabel: `Last publish: ${spoken}, ${value.destinationLabel}${time}.${edited} Press Enter for details.`,
    title: meta.hint,
  }
}

export interface PublishCardIssue extends PublishIssue { canGoTo: boolean }

export interface PublishCardModel {
  title: string
  meta: PublishStatusMeta
  /**
   * The sentence under the title: on a family's main row with failures, the family's count ("2 of 11 products in this
   * family failed in this publish." — it says everything the publication's own sentence would, with the number);
   * otherwise `meta.detailHint`, else `meta.hint`.
   */
  hint: string
  /** This row's own result, when it differs from the publication's (e.g. the publish partly failed, this row passed). */
  rowResult: PublishStatusMeta | null
  inFlight: PublishStatusMeta | null
  facts: Array<{ label: string; value: string }>
  /** "Complete listing" for a create, else the field names; empty when nothing is recorded. */
  sent: string[]
  sentSummary: string
  message: string | null
  issues: PublishCardIssue[]
  editedNote: string | null
  publicationId: string | null
}

/** The detail card behind a "Last publish" cell. `now` = the read's clock, as for the cell. */
export function publishCardModel(value: PublishStatusValue, now: number = Date.now()): PublishCardModel {
  const last = value.last
  const meta = last ? publicationStatusMeta(last.status) : NO_PUBLISH
  const rowResult = last?.outcome ? publishResultMeta(last.outcome) : null
  const sent = !last ? [] : last.sentFields.includes(CREATE_FIELD) ? ['Complete listing'] : [...last.sentFields]
  const sentSummary = !last ? '' : last.sentFields.includes(CREATE_FIELD)
    ? 'A complete new listing was sent.'
    : sent.length === 0 ? 'No field list is recorded for this publish.' : `${sent.length} ${sent.length === 1 ? 'field' : 'fields'} sent.`
  const facts: Array<{ label: string; value: string }> = []
  if (last) {
    // The cell's own shape plus the relative words AsOf and Timeline use, so cell, card and history agree.
    facts.push({ label: 'When', value: Number.isNaN(Date.parse(last.at)) ? last.at : `${publishFullTime(last.at, now)} · ${ago(last.at, now)}` })
    facts.push({ label: 'By', value: last.userName?.trim() || 'Not recorded' })
    if (last.reference) facts.push({ label: 'Channel reference', value: last.reference })
  }
  return {
    title: `Last publish · ${value.destinationLabel}`,
    meta,
    hint: (last && value.family ? publishFamilyMeta(last.status, value.family)?.detailHint : null) ?? meta.detailHint ?? meta.hint,
    rowResult: rowResult && rowResult.label !== meta.label ? rowResult : null,
    inFlight: value.inFlight ? publicationStatusMeta(value.inFlight.status) : null,
    facts,
    sent,
    sentSummary,
    message: last?.message?.trim() || null,
    issues: (last?.issues ?? []).map(issue => ({ ...issue, canGoTo: Boolean(issue.columnKey) })),
    editedNote: value.editedSince ? 'You edited this row after this publish. Publish again to send the change.' : null,
    publicationId: last?.publicationId ?? null,
  }
}
