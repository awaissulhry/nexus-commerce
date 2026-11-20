import type { ReactNode } from 'react'
import type { ExtraOutcome } from '@nexus/factory-domain/order-apply/rules'
import type { StyleDetail } from '../../quotes/api'
import type { AmendPreview, OrderStyleRow } from '../api'
import type { Phrase } from '../model'
import type { Clash, LinesDraft, NoteField, WhyPick } from './lines-draft'
import type { ServerFigures } from './lines-table' // F-OL-09

/**
 * F-OL-01 (Order LINES lane, plan v2 §1) — what the Lines tab draws and what it asks, as plain props: the container hook
 * (use-lines-draft.ts) holds the draft, the Review window, Add a style and the two-people state; the view (view/LinesTab.tsx) draws
 * them and fetches nothing. Absent (a design case without the hook): the tab draws the order as saved, with no draft.
 */

/** "Review and save": the server's preview of THIS draft, and what the person picks in the window. */
export interface ReviewState {
  readonly phase: 'reading' | 'ready' | 'failed'
  /** The draft's key the preview was asked for (an answer for another draft is never drawn). */
  readonly key: string
  readonly preview: AmendPreview | null
  readonly problem: Phrase | null
  /** Why (optional): one quick pick and words. */
  readonly why: WhyPick | null
  readonly words: string
  /** The ONE tick "Ask {customer} to accept the new order"; null: as the preview suggests. */
  readonly ask: boolean | null
  /** Words for the customer and "Also write it in the order's conversation" (null: not touched). */
  readonly tell: { readonly words: string; readonly chosen: boolean | null }
  /** Pieces already cut beyond the new figures: pre-picked "Keep for this customer". */
  readonly extraOutcome: ExtraOutcome | null
  /** A priced (frozen) change's optional fee (price readers; 0 allowed). */
  readonly fee: string
  /** Someone saved meanwhile (a 409, or the order moved while the window was open): said at the top; the preview is asked again. */
  readonly changedMeanwhile: boolean
}

/** "Add a style": the order's own search (our collection + this customer's styles), the style picked, its colours ticked. */
export interface AddStyleState {
  readonly query: string
  readonly results: readonly OrderStyleRow[] | null
  readonly searching: boolean
  readonly problem: Phrase | null
  readonly row: OrderStyleRow | null
  readonly chosen: StyleDetail | null
  readonly picked: readonly string[]
}

/** "+ Add a colour" of one card: the colour picked and the colour row whose sizes it copies. */
export interface AddColourState {
  readonly styleId: string
}

/** Another person saved while I had changes: who, when, which lines moved (the banner; Show scrolls to the first). */
export interface MovedState {
  readonly by: string | null
  readonly at: string
  readonly lineIds: readonly string[]
  /** My changes dropped because they removed the line. */
  readonly gone: readonly string[]
}

export interface LinesTabModel {
  readonly draft: LinesDraft
  readonly canUndo: boolean
  /** Cells both people changed (Keep mine / Take theirs inside the cell); the bar waits until each is chosen. */
  readonly clashes: readonly Clash[]
  readonly moved: MovedState | null
  /** Each style of the order (and of the draft) as read: sizes, colourways, offered sizes; undefined while read, null: failed. */
  readonly styles: Readonly<Record<string, StyleDetail | null | undefined>>
  /** New rows' colourways no price list prices for this customer (a writer without prices cannot add them; Review says it). */
  readonly unlisted: ReadonlySet<string>
  readonly review: ReviewState | null
  readonly addStyle: AddStyleState | null
  readonly addColour: AddColourState | null
  /** The ask "accept the new order" failed after a save (the save stands): "Ask again". */
  readonly askFailed: boolean
  /** The portal said nobody of the customer reads this order there: the conversation tick is held. */
  readonly portalGone: boolean
  /** The options window of one saved line (today's OrderLineOptions, its own container), while open. */
  readonly options: ReactNode | null
  /** A save is running. */
  readonly saving: boolean
  /** F-OL-07: an in-app link away from the order waits for "Stay" or "Leave and discard" (the changes not saved). */
  readonly leaving: boolean
  /** F-OL-09: the server's figures of THIS draft (its preview answered; price readers); null: the table's client estimate. */
  readonly figures: ServerFigures | null
}

export interface LinesTabActions {
  readonly onCell?: (key: string, size: string, pieces: number) => void
  readonly onPrice?: (key: string, text: string) => void
  readonly onText?: (key: string, field: NoteField, text: string) => void
  readonly onRemove?: (key: string) => void
  readonly onPutBack?: (lineId: string) => void
  readonly onUndo?: () => void
  readonly onDiscard?: () => void
  readonly onAddSize?: (styleId: string, size: string) => void
  /** A card was focused: its style is read (its sizes and colourways, for + Size and + Add a colour). */
  readonly onReadStyle?: (styleId: string) => void
  // ---- Review and save ----
  readonly onReview?: () => void
  readonly onReviewClose?: () => void
  readonly onReviewRetry?: () => void
  readonly onReviewWhy?: (pick: WhyPick | null) => void
  readonly onReviewWords?: (text: string) => void
  readonly onReviewAsk?: (on: boolean) => void
  readonly onReviewTell?: (next: { readonly words?: string; readonly chosen?: boolean }) => void
  readonly onReviewOutcome?: (outcome: ExtraOutcome) => void
  readonly onReviewFee?: (text: string) => void
  /** Save changes: the reason in words (none: the server's automatic words) and the words typed for the customer (none: the default
   * question in the customer's language — F-OL-08). */
  readonly onSave?: (input: { readonly reason?: string; readonly question: string }) => void
  readonly onAskAgain?: () => void
  readonly onAskDismiss?: () => void
  // ---- two people ----
  readonly onKeepMine?: (clash: Clash) => void
  readonly onTakeTheirs?: (clash: Clash) => void
  readonly onMovedDismiss?: () => void
  // ---- Add a style, + Add a colour ----
  readonly onAddStyleOpen?: () => void
  readonly onAddStyleClose?: () => void
  readonly onAddStyleQuery?: (query: string) => void
  readonly onAddStylePick?: (row: OrderStyleRow | null) => void
  readonly onAddStyleToggle?: (colourwayId: string) => void
  readonly onAddStyleAdd?: () => void
  readonly onAddColourOpen?: (styleId: string | null) => void
  readonly onAddColour?: (styleId: string, colourwayId: string, copyFrom: string | null) => void
  // ---- the row ⋯ acts that live in the table's draft or the line's own windows ----
  readonly onOptions?: (lineId: string | null) => void
  /** A door lands on a row (Overview's ⋯, the band's "Change the lines", Money's "Change our price ›"): the Lines tab, the box focused. */
  readonly onLand?: (target: { readonly lineId: string | null; readonly box: 'first' | 'price' }) => void
  // ---- F-OL-07: leaving the order with changes ----
  readonly onLeaveStay?: () => void
  readonly onLeaveGo?: () => void
}
