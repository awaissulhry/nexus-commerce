'use client'

import { useRef, type KeyboardEvent, type ReactNode } from 'react'
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
 * The docked thread's bands above the feed (B-TH-300; pictures 6–11): the Head with Activity's doors (T1) and the files line (T2),
 * and the helpers beside the box (T8). Slots drawn by the office container: this view imports no office code.
 */
export interface RecordThreadSlots {
  /** The Head (lib/record-thread/head): one 44 px row; not drawn without threads.read. */
  head?: ReactNode
  /** The files line (lib/record-thread/files): absent with no files. */
  filesLine?: ReactNode
  /** Saved replies ▾ beside the @ button. */
  helpers?: ReactNode
  /** The pop-ups the bands open (file viewer, Files view, the doors' dialogs): drawn after the column. */
  overlays?: ReactNode
}

/**
 * RecordThread (B-TH-212 v1, B-TH-300 docked; pictures 1–11): a record's thread in ONE column — the feed (oldest at the top) and the
 * box at the bottom, with its files, To / Cc and the send check — for Incoming's reading pane and the request's full page; docked on
 * a record page (RecordFrame) the Head and the files line join above the feed (3 bands above the first message with the band in the
 * shell's row) and the helpers beside the box. R and N switch the box from anywhere in the column outside a field; J / K walk the
 * messages while the feed has the focus. Office only (PR-15: the portal keeps the DS PartnerThread). Draws its model: the office
 * container (areas/_shared/record-thread) reads, re-reads live and sends.
 */
export function RecordThread({ model, actions, remind, slots }: { model: RecordThreadModel; actions: RecordThreadActions; remind?: (messageId: string) => ReactNode; slots?: RecordThreadSlots }) {
  return (
    <ThreadMessages>
      <Column model={model} actions={actions} remind={remind} slots={slots} />
    </ThreadMessages>
  )
}

function Column({ model, actions, remind, slots }: { model: RecordThreadModel; actions: RecordThreadActions; remind?: (messageId: string) => ReactNode; slots?: RecordThreadSlots }) {
  const t = useT('record-thread')
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
      <section ref={column} className={`fw-rt-column${slots?.head ? ' is-docked' : ''}`} aria-label={t('label', { record: model.title })} onKeyDown={onKeyDown}>
        {model.feed.state !== 'forbidden' && slots?.head}
        {model.feed.state !== 'forbidden' && slots?.filesLine}
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
            // B-TH-236: Correct puts the box on the message's way, with its "Correcting …" line, and the cursor in it.
            onCorrect: (messageId) => {
              actions.onCorrect?.(messageId)
              focusBox()
            },
          }}
          remind={remind}
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
            clip={<ClipMenu canUpload={composer.canUpload} canPick={composer.canPick} onFiles={actions.onFiles} onPick={() => actions.onPicker(true)} onSheets={actions.onSheets} />}
            onDraft={actions.onDraft}
            onSend={actions.onSend}
            onReopen={actions.onReopen}
            onMakeCustomer={actions.onMakeCustomer}
            onEscape={() => column.current?.querySelector<HTMLElement>('.fw-rt-feed')?.focus()}
            onFiles={composer.canUpload ? actions.onFiles : undefined}
            onSheets={composer.canUpload ? actions.onSheets : undefined}
            hint={<DraftLine draft={model.kept ?? null} saved={model.saved ?? null} onRetry={actions.onRetryDraft} /* B-TH-287 */ />}
            helpers={
              composer.followUp ? (
                <>
                  {slots?.helpers}
                  {/* B-TH-289: beside Saved replies, on a message to the customer. */}
                  <FollowUpTick model={composer.followUp} onChange={actions.onFollowUp} />
                </>
              ) : (
                slots?.helpers
              )
            }
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
      </section>
      {slots?.overlays}
    </>
  )
}
