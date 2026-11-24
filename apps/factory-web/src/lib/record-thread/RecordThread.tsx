'use client'

import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Banner } from '@nexus/ui/components'
import { useT } from '../i18n/provider'
import { AttachmentLines, AttachmentTray, ClipMenu, FromRecordPicker } from './attachments/view/AttachmentTray'
import { MAIL_MAX, mailBytes, trayHeld, type DraftFile, type RecordFile } from './attachments/model'
import { composerModes, keyMode, switchMode, type ComposerContext, type ComposerDraft, type SwitchNote } from './composer/model'
import { Composer } from './composer/view/Composer'
import { LeaveConfirm } from './popups/view/Confirms'
import { DraftLine } from './helpers/view/SavedReplies'
import type { LocalDraft } from './helpers/model'
import { Feed, type FeedActions, type FeedModel } from './feed/view/Feed'
import { recipientsHeld, type CheckState, type Contact, type Recipient } from './send-check/model'
import { Recipients } from './send-check/view/Recipients'
import { SendCheckDialog } from './send-check/view/SendCheckDialog'
import { ThreadMessages } from './parts/ThreadMessages'
// B-TH-287: the draft on the server; B-TH-289: "Remind me in 3 days if no answer".
import type { DraftSaved } from './composer/server-draft'
import { FollowUpTick, type FollowUpModel } from './helpers/view/FollowUp'
// tw- W2.1 (Z4, Z14): the pick goes into the head's title; the pinned bar lives here, for every host.
import { HeadPickProvider } from './head/view/HeadPick'
import { PinnedBar } from './head/view/PinnedBar'
import type { BarPin } from './head/pins-bar'
// tw- W2.2 (B7, Z2): the ONE Email details window, opened from a message's menu, for every host.
import { emailDetailsOf, type CardMessage } from './card/model'
import { verdictOf } from './popups/model'
import { OriginalEmail, type OriginalEmailModel } from './popups/view/OriginalEmail'
import './record-thread.css'

export interface ThreadComposerModel {
  context: ComposerContext
  draft: ComposerDraft
  notes: readonly SwitchNote[]
  sending: boolean
  files: readonly DraftFile[]
  recordFiles: readonly RecordFile[]
  /** files.upload; files.manage (share a file with the customer); files.read (From this record). */
  canUpload: boolean
  canShare: boolean
  canPick: boolean
  to: readonly Recipient[]
  cc: readonly Recipient[]
  subject: string
  contacts: readonly Contact[]
  /** B-TH-289 (B-TH-096): the follow-up tick on a message to the customer; null or absent: not offered (an office note). */
  followUp?: FollowUpModel | null
}

export interface RecordThreadModel {
  /** The record's name, for the column's accessible name ("SO-2026-0101 · Brand Alpha"). */
  title: string
  feed: FeedModel
  composer: ThreadComposerModel
  pickerOpen?: boolean
  /** The send check, open. */
  check?: { state: CheckState; outside: boolean } | null
  /** The draft kept on this device (TH-1c's DraftLine under the box, B-TH-208). */
  kept?: LocalDraft | null
  /** "Leave with unsent text?" open (TH-1c's LeaveConfirm, B-TH-211). */
  leaving?: boolean
  /** A notice over the thread: a key of a record-thread catalogue, with its tone. */
  notice?: { ns: string; key: string; params?: Record<string, string | number>; tone: 'success' | 'info' | 'warning' | 'danger' } | null
  /** B-TH-287 (B-TH-092): the draft on the server — "Draft saved 10:42", "Not saved · Retry"; null: the device line. */
  saved?: DraftSaved | null
  /** tw- W2.1 (W-080, Z14): the pins, newest first, for the pinned bar under the head (every host; the Incoming pane too). */
  pinned?: readonly BarPin[]
}

export interface RecordThreadActions extends FeedActions {
  onDraft: (draft: ComposerDraft, notes: readonly SwitchNote[]) => void
  onSend: () => void
  onReopen?: () => void
  onMakeCustomer?: () => void
  onFiles: (files: File[]) => void
  /** B-TH-283: files that go up as measurement sheets (the paper clip's "Measurement sheet…", the box's measurement side). */
  onSheets?: (files: File[]) => void
  onRemoveFile: (key: string) => void
  onRetryFile: (key: string) => void
  onShareFile: (key: string) => void
  onPicker: (open: boolean) => void
  onAddRecordFiles: (ids: string[]) => void
  onLines: (next: { to: Recipient[]; cc: Recipient[]; subject: string }) => void
  onCheckBack: () => void
  onCheckRetry: () => void
  onOutside: (ticked: boolean) => void
  onConfirm: () => void
  onStay: () => void
  onDiscard: () => void
  onDismissNotice?: () => void
  /** B-TH-287: "Retry" after the draft could not be saved on the server. */
  onRetryDraft?: () => void
  /** B-TH-289: the follow-up tick. */
  onFollowUp?: (on: boolean) => void
  /** B-TH-288 (T1-F08): "/" from anywhere in the column outside a field opens "Search in the thread" (office, docked). */
  onSlash?: () => void
}

/**
 * The docked thread's bands above the feed (B-TH-300; pictures 6–11): the Head with Activity's doors (T1; tw- W2.1: one row, the pick
 * as its title, Files as an icon), and the helpers beside the box (T8). Slots drawn by the office container: this view imports no office code.
 */
export interface RecordThreadSlots {
  // ---- F-OP-201 (order page plan N4; 11-dock §0.1, §1): the dock's pick (ThreadPick's, handed down by the docked container). tw- W2.1
  // (Z4): no band of its own — the head draws it as its title (HeadPick); when the feed is forbidden only that title is drawn (P19:
  // the person can still pick another thread). Absent on a page without a pick (a quote, an invoice): the head shows the record.
  top?: ReactNode
  // ---- end F-OP-201
  /** The Head (lib/record-thread/head): one row of two lines; not drawn without threads.read (its title alone then, with the pick). */
  head?: ReactNode
  /** Saved replies ▾ beside the @ button. */
  helpers?: ReactNode
  /** The pop-ups the bands open (file viewer, Files view, the doors' dialogs): drawn after the column. */
  overlays?: ReactNode
}

/**
 * RecordThread (B-TH-212 v1, B-TH-300 docked; pictures 1–11): a record's thread in ONE column — the feed (oldest at the top) and the
 * box at the bottom, with its files, To / Cc and the send check — for Incoming's reading pane and the request's full page; docked on
 * a record page (RecordFrame) the Head joins above the feed and, with a pin, the pinned bar (tw- W2.1: at most these 2 bands above the
 * first message) and the helpers beside the box. R and N switch the box from anywhere in the column outside a field; J / K walk the
 * messages while the feed has the focus. Office only (PR-15: the portal keeps the DS PartnerThread). Draws its model: the office
 * container (areas/_shared/record-thread) reads, re-reads live and sends.
 */
export function RecordThread({ model, actions, slots }: { model: RecordThreadModel; actions: RecordThreadActions; slots?: RecordThreadSlots }) {
  return (
    <ThreadMessages>
      <Column model={model} actions={actions} slots={slots} />
    </ThreadMessages>
  )
}

function Column({ model, actions, slots }: { model: RecordThreadModel; actions: RecordThreadActions; slots?: RecordThreadSlots }) {
  const t = useT('record-thread')
  const card = useT('record-thread-card')
  // tw- W2.2: the message whose Email details are open (the window reads the message as the feed holds it: nothing is fetched).
  const [detailsOf, setDetailsOf] = useState<string | null>(null)
  const details = detailsOf ? emailWindowOf(model.feed.state === 'ready' ? model.feed.messages.find((one) => one.id === detailsOf) : undefined, card) : null
  const attach = useT('record-thread-attach')
  const send = useT('record-thread-send')
  const notice = useT(model.notice?.ns ?? 'record-thread')
  const column = useRef<HTMLElement>(null)
  const { composer } = model
  const party = composer.context.party?.name ?? composer.context.prospect?.name ?? ''
  const mode = composer.draft.mode
  const tray = trayHeld(composer.files, mode)
  const lines = mode === 'reply' ? recipientsHeld(composer.to, composer.cc, composer.subject) : null
  const extraHeld = tray ? attach(tray.key, tray.params) : lines ? send(lines.key, lines.params) : null
  const focusBox = () => requestAnimationFrame(() => column.current?.querySelector<HTMLTextAreaElement>('.fw-rt-cx-text')?.focus())

  // R / N from anywhere in the column outside a field (T5-F11); the feed's own J / K stay with the feed.
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return
    const target = event.target as HTMLElement
    const inField = /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable || Boolean(target.closest('[role="dialog"], [role="menu"]'))
    // B-TH-288: "/" opens the search over the Head row.
    if (event.key === '/' && !inField && actions.onSlash) {
      event.preventDefault()
      actions.onSlash()
      return
    }
    const next = keyMode(event.key, composerModes(composer.context), inField)
    if (!next || model.feed.state !== 'ready') return
    event.preventDefault()
    const switched = switchMode(composer.draft, next, composer.context.people)
    actions.onDraft(switched.draft, switched.notes)
    focusBox()
  }

  return (
    <>
      <section ref={column} className={`fw-rt-column${slots?.head || slots?.top /* F-OP-201 */ ? ' is-docked' : ''}`} aria-label={t('label', { record: model.title })} onKeyDown={onKeyDown}>
        <HeadPickProvider pick={slots?.top ?? null}>
        {/* tw- W2.1 (Z4, P19): the head with the pick as its title; a forbidden feed keeps only the title (the pick), no tools. */}
        {model.feed.state !== 'forbidden' && slots?.head ? slots.head : slots?.top ? <TitleOnly pick={slots.top} /> : null}
        {/* tw- W2.1 (W-080, Z14): the pinned bar — the second and last band above the first message (S7). */}
        {model.feed.state !== 'forbidden' && model.pinned && model.pinned.length > 0 ? <PinnedBar pins={model.pinned} onJump={actions.onJump} /> : null}
        {model.notice && (
          <div className="fw-rt-notice" role={model.notice.tone === 'danger' ? 'alert' : 'status'}>
            <Banner tone={model.notice.tone} onDismiss={actions.onDismissNotice}>
              {notice(model.notice.key, model.notice.params)}
            </Banner>
          </div>
        )}
        <Feed
          model={model.feed}
          actions={{
            ...actions,
            onReply: (messageId) => {
              actions.onReply?.(messageId)
              focusBox()
            },
            // tw- W1.4 (W-037): Reply privately — an office note that quotes the customer's message — puts the cursor in the box too.
            onReplyPrivately: (messageId) => {
              actions.onReplyPrivately?.(messageId)
              focusBox()
            },
            // B-TH-236: Correct puts the box on the message's way, with its "Correcting …" line, and the cursor in it.
            onCorrect: (messageId) => {
              actions.onCorrect?.(messageId)
              focusBox()
            },
            onEmailDetails: (messageId) => setDetailsOf(messageId), // tw- W2.2
          }}
        />
        {model.feed.state !== 'forbidden' && (
          <Composer
            context={composer.context}
            draft={composer.draft}
            notes={composer.notes}
            sending={composer.sending}
            hasFiles={composer.files.some((file) => file.phase === 'done')}
            extraHeld={extraHeld}
            now={model.feed.now}
            recipients={<Recipients to={composer.to} cc={composer.cc} subject={composer.subject} contacts={composer.contacts} partyName={party} onChange={actions.onLines} />}
            tray={<AttachmentTray files={composer.files} partyName={party} onRemove={actions.onRemoveFile} onRetry={actions.onRetryFile} />}
            lines={<AttachmentLines files={composer.files} mode={mode} partyName={party} canShare={composer.canShare} overMailLimit={mailBytes(composer.files) > MAIL_MAX} onShare={actions.onShareFile} onRemove={actions.onRemoveFile} />}
            // tw- W2.3: the "+" — the files' rows, then the composer's own (Saved replies · Amount · For the floor).
            plus={(more) => <ClipMenu canUpload={composer.canUpload} canPick={composer.canPick} onFiles={actions.onFiles} onPick={() => actions.onPicker(true)} onSheets={actions.onSheets} more={more} />}
            onDraft={actions.onDraft}
            onSend={actions.onSend}
            onReopen={actions.onReopen}
            onMakeCustomer={actions.onMakeCustomer}
            onEscape={() => column.current?.querySelector<HTMLElement>('.fw-rt-feed')?.focus()}
            onFiles={composer.canUpload ? actions.onFiles : undefined}
            onSheets={composer.canUpload ? actions.onSheets : undefined}
            hint={<DraftLine draft={model.kept ?? null} saved={model.saved ?? null} onRetry={actions.onRetryDraft} /* B-TH-287 */ />}
            helpers={slots?.helpers}
            // B-TH-289 / tw- W2.3: the Follow up chip, in the chips row on a message to the customer.
            followUp={composer.followUp ? <FollowUpTick model={composer.followUp} onChange={actions.onFollowUp} /> : null}
          />
        )}
        <FromRecordPicker open={model.pickerOpen ?? false} files={composer.recordFiles} mode={mode} partyName={party} record={composer.context.recordLabel} onClose={() => actions.onPicker(false)} onAdd={actions.onAddRecordFiles} />
        <SendCheckDialog
          model={{
            open: Boolean(model.check),
            state: model.check?.state ?? { status: 'checking' },
            partyName: party,
            to: composer.to,
            cc: composer.cc,
            files: composer.files.filter((file) => file.phase === 'done').length,
            outside: model.check?.outside ?? false,
            sending: composer.sending,
            correction: composer.draft.link?.kind === 'correct',
          }}
          actions={{ onBack: actions.onCheckBack, onRetry: actions.onCheckRetry, onOutside: actions.onOutside, onConfirm: actions.onConfirm }}
        />
        {model.leaving && <LeaveConfirm files={composer.files.filter((file) => file.phase !== 'refused').length} onStay={actions.onStay} onDiscard={actions.onDiscard} />}
        {details && <OriginalEmail model={details} onClose={() => setDetailsOf(null)} />}
        </HeadPickProvider>
      </section>
      {slots?.overlays}
    </>
  )
}

/** tw- W2.2: a message's Email details as the window says them (our email's state in its words; an inbound one's checks); null: none. */
export function emailWindowOf(message: CardMessage | undefined, card: (key: string) => string): OriginalEmailModel | null {
  const details = message ? emailDetailsOf(message) : null
  if (!details) return null
  return {
    from: details.from,
    to: details.to,
    cc: details.cc,
    subject: details.subject,
    receivedAt: details.at,
    bodyHtml: null,
    bodyText: details.text,
    verdicts: details.verdicts ? { spf: verdictOf(details.verdicts.spf), dkim: verdictOf(details.verdicts.dkim), dmarc: verdictOf(details.verdicts.dmarc) } : null,
    sent: details.sent,
    status: details.status ? card(`delivery.${details.status}`) : null,
  }
}

/** tw- W2.1 (P19): a head of its title alone — the dock's pick — when the thread may not be read (no tools, no count). */
function TitleOnly({ pick }: { pick: ReactNode }) {
  return (
    <div className="fw-rth is-title-only">
      <div className="fw-rth-titleblock">
        <div className="fw-rth-title">{pick}</div>
      </div>
    </div>
  )
}
