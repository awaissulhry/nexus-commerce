/**
 * owner owb-fl8 — the basket page's problems, asks, photo and the office's notes (design § 5zf B–D; lead settles 1, 5). STUBS made
 * by owb-fl5 (web A) with the names web B chose; web B replaces this file's bodies in fl8 and never edits fl5's page.
 *
 * The basket page imports Problem, Ask, Photo, Notes ONLY from here. While `HELP_READY` is false the page draws none of their
 * buttons (never a dead button): no tile row, no "Ask your team leader".
 *
 * Every tile and card takes `{ read, onChanged }`: `read` is the page's parsed basket read as it is (a structural superset of
 * HelpRead); `onChanged` re-reads the basket after a call is sent or answered.
 */
import type { ReactElement } from 'react'

/** A help call on the basket (a problem or an ask). */
export interface HelpCallFlag {
  readonly callId: string
  readonly typeCode: string
  readonly state: string
  readonly minutes: number
  readonly escalated: boolean
  readonly spot?: number | null
}

/** What the help parts read of the basket read (common § 3 "fl1"). */
export interface HelpRead {
  readonly basket: { readonly id: string; readonly code: string; readonly workOrderId: string } | null
  readonly picture: { readonly src: string } | null
  readonly here: { readonly departmentId: string | null } | null
  readonly flags: { readonly problem: HelpCallFlag | null; readonly ask: HelpCallFlag | null; readonly answer: { readonly words: string; readonly at: string } | null } | null
  readonly notes: readonly { readonly at: string; readonly words: string; readonly fileIds: readonly string[] }[]
}

export interface HelpPartProps {
  readonly read: HelpRead
  readonly onChanged?: () => void
}

export interface HelpWindowProps extends HelpPartProps {
  readonly open: boolean
  readonly onClose: () => void
}

export interface CallAnswerButtonsProps {
  readonly callId: string
  readonly state: string
  readonly onChanged?: () => void
}

/** fl8 sets true when the parts below are real. */
export const HELP_READY: boolean = false

/** The words of the help parts (fl8's catalogue). */
export const HELP2_NAMESPACE = 'floor-help2'

/** The four tiles in one row: each is its button and its own window. */
export function ProblemTile(_props: HelpPartProps): ReactElement | null {
  return null
}
export function AskTile(_props: HelpPartProps): ReactElement | null {
  return null
}
export function PhotoTile(_props: HelpPartProps): ReactElement | null {
  return null
}
export function NotesTile(_props: HelpPartProps): ReactElement | null {
  return null
}

/** The windows alone (the dock's "Ask your team leader" opens AskWindow). */
export function ProblemWindow(_props: HelpWindowProps): ReactElement | null {
  return null
}
export function AskWindow(_props: HelpWindowProps): ReactElement | null {
  return null
}
export function PhotoWindow(_props: HelpWindowProps): ReactElement | null {
  return null
}
export function NotesWindow(_props: HelpWindowProps): ReactElement | null {
  return null
}

/** "What needs you": the red problem card, the open ask with "An answer for you". Nothing when the flag is null. */
export function ProblemCard(_props: HelpPartProps): ReactElement | null {
  return null
}
export function AskCard(_props: HelpPartProps): ReactElement | null {
  return null
}

/** A team leader's On my way / Solved on a call. */
export function CallAnswerButtons(_props: CallAnswerButtonsProps): ReactElement | null {
  return null
}
