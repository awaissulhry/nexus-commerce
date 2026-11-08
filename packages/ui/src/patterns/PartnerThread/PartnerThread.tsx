'use client'

/**
 * PartnerThread — the partner side of a record's thread (B-W2b-155, design part PartnerThread; anatomy D17): the
 * conversation about one order, PO, job or document as a customer or supplier sees it in the portal.
 *
 *   <PartnerThread record={<RefPair … />} companyName="Studio Alpha" messages={messages}
 *                  composer={{ value, onChange, onSend, busy, hint: thread.composer.hint }} labels={ds.partnerThread} />
 *
 * - Only what is shared with the partner: our messages and theirs, by mail or in the portal, with the files they may
 *   see. There is no internal-note kind at all, so an office note cannot be drawn here.
 * - `messages` are drawn in the order given — OLDEST FIRST (a conversation reads down); `loadMore` ("Earlier
 *   messages") sits above them. Each message: who (the reader's own say "You"), how it came (by e-mail, in the portal),
 *   when (written by the app), the text as PLAIN text with its line breaks (`body`; a mail's HTML is never drawn here),
 *   and its files as links. Ours on one side and theirs on the other on a desktop; full width on a phone.
 * - The composer: a text box (the Textarea counter with `limit`), the record's files they may attach (ticks), Send —
 *   held with the reason while empty or sending (never dead); after Send the focus stays in the box. Ctrl / ⌘ + Enter
 *   sends too. When the person may not write (`heldReason`: a read-only role, a closed conversation, a preview), the
 *   reason is shown in place of the box. `hint` ("You can also answer our e-mails") is shown under it either way.
 */
import { useId, useRef, type FormEvent, type KeyboardEvent, type ReactNode } from 'react'
import { AlertCircle, Lock, Mail, Paperclip } from 'lucide-react'

import { mergeLabels } from '../../lib/labels'
import { Button } from '../../primitives/Button'
import { Checkbox } from '../../primitives/Checkbox'
import { Spinner } from '../../primitives/Spinner'
import { Textarea } from '../../primitives/Textarea'
import type { TextareaLabels } from '../../primitives/TextareaLabels'
import { PARTNER_THREAD_LABELS, type PartnerThreadLabels } from './PartnerThreadLabels'
import { partnerAuthorName, partnerSendHeld, partnerToggleFile, type PartnerAuthor, type PartnerChannel, type PartnerSide } from './partnerThreadModel'
import './partnerThread.css'

export interface PartnerAttachment {
  id: string
  name: string
  /** Its size, written by the app ("673 KB"). */
  size?: string
  /** Where it opens or downloads; without it the name is plain text. */
  href?: string
}

export interface PartnerMessage {
  id: string
  side: PartnerSide
  channel: PartnerChannel
  author: PartnerAuthor
  /** The text, drawn as plain text with its line breaks. */
  body: string
  attachments?: readonly PartnerAttachment[]
  /** When, as an ISO instant (the `<time>`'s machine value). */
  at: string
  /** When, written in the page's language and the site's zone. */
  atText: string
}

export interface PartnerComposer {
  value: string
  onChange: (value: string) => void
  onSend: () => void
  /** Sending: Send is held with the sending words. */
  busy?: boolean
  /** The person may not write here, in words (shown instead of the box). */
  heldReason?: string | null
  /** "You can also answer our e-mails." */
  hint?: string | null
  /** The record's files shared with them that may go with the message. */
  files?: readonly { id: string; name: string }[]
  /** The ids ticked (in `files`). */
  attached?: readonly string[]
  onAttach?: (ids: string[]) => void
  /** The text's limit in characters (the Textarea counts, never blocks). */
  limit?: number
}

export interface PartnerThreadProps {
  messages: readonly PartnerMessage[]
  /** The heading (default `labels.title`). */
  title?: ReactNode
  /** The record: the page passes a `RefPair` (their reference first). */
  record?: ReactNode
  /** Who "we" are: the name on our messages without a person's name. */
  companyName: string
  /** Null: no composer (a page that only reads). */
  composer?: PartnerComposer | null
  /** Earlier messages to show above. */
  loadMore?: { onClick: () => void; busy?: boolean } | null
  state?: 'ready' | 'loading' | 'error'
  onRetry?: () => void
  /** Words when there is no message yet (default `labels.empty`). */
  empty?: ReactNode
  /** The level of the heading (default 3). */
  headingLevel?: 2 | 3 | 4
  labels?: Partial<PartnerThreadLabels>
  /** The Textarea counter's words. */
  textareaLabels?: Partial<TextareaLabels>
  className?: string
}

export function PartnerThread({
  messages, title, record, companyName, composer = null, loadMore = null, state = 'ready', onRetry, empty, headingLevel = 3, labels, textareaLabels, className,
}: PartnerThreadProps) {
  const lw = mergeLabels(PARTNER_THREAD_LABELS, labels)
  const uid = useId()
  const titleId = `${uid}-title`
  const H = `h${headingLevel}` as 'h3'

  return (
    <section className={['nds-pthread', className].filter(Boolean).join(' ')} aria-labelledby={titleId}>
      <div className="nds-pthread-head">
        <H id={titleId} className="nds-pthread-title">
          {title ?? lw.title}
        </H>
        {record ? <div className="nds-pthread-record">{record}</div> : null}
      </div>

      {state === 'loading' ? (
        <p className="nds-pthread-state" role="status">
          <Spinner size={16} />
          <span>{lw.loading}</span>
        </p>
      ) : state === 'error' ? (
        <div className="nds-pthread-state" data-tone="danger" role="alert">
          <AlertCircle aria-hidden className="nds-pthread-icon" />
          <span>{lw.failed}</span>
          {onRetry ? <Button onClick={onRetry}>{lw.retry}</Button> : null}
        </div>
      ) : (
        <>
          {loadMore ? (
            <div className="nds-pthread-more">
              <Button size="sm" variant="quiet" onClick={loadMore.onClick} heldReason={loadMore.busy ? lw.reading : null}>
                {loadMore.busy ? <Spinner size={14} /> : null}
                {lw.earlier}
              </Button>
            </div>
          ) : null}
          {messages.length === 0 ? (
            <p className="nds-pthread-empty">{empty ?? lw.empty}</p>
          ) : (
            <ol className="nds-pthread-list" aria-label={lw.conversation}>
              {messages.map((message) => (
                <MessageItem key={message.id} message={message} companyName={companyName} lw={lw} />
              ))}
            </ol>
          )}
          {composer ? <Composer composer={composer} lw={lw} textareaLabels={textareaLabels} /> : null}
        </>
      )}

      {composer?.hint ? (
        <p className="nds-pthread-hint">
          <Mail aria-hidden className="nds-pthread-icon" />
          <span>{composer.hint}</span>
        </p>
      ) : null}
    </section>
  )
}

function MessageItem({ message, companyName, lw }: { message: PartnerMessage; companyName: string; lw: PartnerThreadLabels }) {
  const who = partnerAuthorName(message, companyName, lw)
  const files = message.attachments ?? []
  return (
    <li className="nds-pthread-item" data-side={message.side} data-mine={message.author.mine ? 'true' : undefined}>
      <article className="nds-pthread-msg" aria-label={lw.messageFrom(who, message.atText)}>
        <div className="nds-pthread-meta">
          <strong className="nds-pthread-author">{who}</strong>
          <span className="nds-pthread-channel">{lw.channels[message.channel]}</span>
          <time className="nds-pthread-time" dateTime={message.at}>
            {message.atText}
          </time>
        </div>
        {message.body ? <p className="nds-pthread-body">{message.body}</p> : null}
        {files.length > 0 ? (
          <ul className="nds-pthread-files" aria-label={lw.attachments}>
            {files.map((file) => (
              <li key={file.id} className="nds-pthread-file">
                <Paperclip aria-hidden className="nds-pthread-icon" />
                {file.href ? <a href={file.href}>{file.name}</a> : <span>{file.name}</span>}
                {file.size ? <span className="nds-pthread-size">{file.size}</span> : null}
              </li>
            ))}
          </ul>
        ) : null}
      </article>
    </li>
  )
}

function Composer({ composer, lw, textareaLabels }: { composer: PartnerComposer; lw: PartnerThreadLabels; textareaLabels?: Partial<TextareaLabels> }) {
  const uid = useId()
  const box = useRef<HTMLTextAreaElement>(null)
  if (composer.heldReason) {
    return (
      <p className="nds-pthread-held" role="note">
        <Lock aria-hidden className="nds-pthread-icon" />
        <span>{composer.heldReason}</span>
      </p>
    )
  }
  const files = composer.files ?? []
  const attached = composer.attached ?? []
  const held = partnerSendHeld({ value: composer.value, busy: composer.busy, attached: attached.length }, lw)
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (held) return
    composer.onSend()
    box.current?.focus()
  }
  const keys = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      event.currentTarget.form?.requestSubmit()
    }
  }
  return (
    <form className="nds-pthread-composer" onSubmit={submit} noValidate>
      <label className="nds-pthread-label" htmlFor={`${uid}-text`}>
        {lw.composer}
      </label>
      <Textarea
        ref={box}
        id={`${uid}-text`}
        value={composer.value}
        onChange={(event) => composer.onChange(event.target.value)}
        onKeyDown={keys}
        rows={3}
        honourRows
        limit={composer.limit}
        labels={textareaLabels}
      />
      {files.length > 0 ? (
        <fieldset className="nds-pthread-attach">
          <legend className="nds-pthread-label">{lw.attach}</legend>
          <p className="nds-pthread-note">{lw.attachHint}</p>
          {files.map((file) => (
            <Checkbox
              key={file.id}
              label={file.name}
              checked={attached.includes(file.id)}
              onChange={() => composer.onAttach?.(partnerToggleFile(attached, file.id, files))}
            />
          ))}
        </fieldset>
      ) : null}
      <div className="nds-pthread-send">
        {attached.length > 0 ? <span className="nds-pthread-note">{lw.attached(attached.length)}</span> : null}
        <Button type="submit" variant="primary" heldReason={held}>
          {composer.busy ? <Spinner size={14} /> : null}
          {lw.send}
        </Button>
      </div>
    </form>
  )
}
