'use client'

import { useEffect, useMemo, useState } from 'react'
import { AtSign, Lock, Mail, MailOpen, Paperclip, Send } from 'lucide-react'
import { Banner, Disclosure, EmptyState, Field } from '@nexus/ui/components'
import { ReplyComposer } from '@nexus/ui/patterns'
import { Button, Checkbox, Input, SegmentedControl, Spinner, Tag } from '@nexus/ui/primitives'
import { formatDateTime } from '../../lib/i18n/format'
import { useLocale, useT } from '../../lib/i18n/provider'
import {
  attachableFiles,
  audienceBadges,
  composerAbsentReason,
  composerHeld,
  composerModes,
  MAX_BODY_LENGTH,
  type ComposerDraft,
  type ComposerMode,
  type EmailStatus,
  type PanelMessage,
  type RecordPanelsViewModel,
} from '../model'
import type { RecordPanelsActions } from './actions'

const EMAIL_TONE: Readonly<Record<EmailStatus, 'neutral' | 'info' | 'success' | 'danger'>> = {
  QUEUED: 'info',
  SENDING: 'info',
  SENT: 'neutral',
  DELIVERED: 'success',
  BOUNCED: 'danger',
  COMPLAINED: 'danger',
  FAILED: 'danger',
}

const sizeWords = (bytes: number, locale: string) =>
  bytes >= 1_048_576 ? `${(bytes / 1_048_576).toLocaleString(locale, { maximumFractionDigits: 1 })} MB` : `${Math.max(1, Math.round(bytes / 1024)).toLocaleString(locale)} KB`

/**
 * The thread of a record (COL-001, COL-003, COL-024): the composer — an INTERNAL NOTE (the office only) or an EMAIL TO
 * THE PARTY (sent as the person, shared with the party, replies come back here) — then the messages, newest first. An
 * internal note and a shared message never look alike: each carries its mark (a lock, or the party's name) and its own
 * edge, so nobody reads a note as something the customer saw.
 */
export function ThreadPanel({ model, actions }: { model: RecordPanelsViewModel; actions?: RecordPanelsActions }) {
  const t = useT('records')
  const locale = useLocale()
  const modes = composerModes(model)
  const absent = composerAbsentReason(model)
  const closed = model.thread?.status === 'CLOSED'
  const partyName = model.party?.name || t('message.theParty')

  const [mode, setMode] = useState<ComposerMode>(model.composerMode && modes.includes(model.composerMode) ? model.composerMode : (modes[0] ?? 'note'))
  const [body, setBody] = useState(model.composerText ?? '')
  // The To line starts from the party's known addresses, and follows them only when they change (not on every render).
  const defaultTo = model.party?.emails.join(', ') ?? ''
  const [to, setTo] = useState(defaultTo)
  const [subject, setSubject] = useState('')
  const [mentions, setMentions] = useState<string[]>([])
  const [attachments, setAttachments] = useState<string[]>([])
  useEffect(() => setTo(defaultTo), [defaultTo])

  const files = useMemo(() => model.files.items ?? [], [model.files.items])
  const attachable = useMemo(() => attachableFiles(files, mode, model.party), [files, mode, model.party])
  // A file that may not go with this mode (a note's internal file, when the mode becomes email) leaves the draft. The
  // same list is kept when nothing left it, so this never loops.
  useEffect(
    () =>
      setAttachments((chosen) => {
        const kept = chosen.filter((id) => attachable.some((file) => file.id === id))
        return kept.length === chosen.length ? chosen : kept
      }),
    [attachable],
  )

  const draft: ComposerDraft = { mode, body, to, subject, mentions: mode === 'note' ? mentions : [], attachments }
  const hasMail = (model.messages.items ?? []).some((message) => message.channel === 'EMAIL')
  const held = composerHeld(draft, { threadClosed: closed, sending: model.sending ?? false, files, hasMail })
  const heldText = held ? t(held.key, held.params) : null

  const send = () => {
    if (held || !actions?.onSend) return
    void actions.onSend(draft).then((sent) => {
      if (!sent) return
      setBody('')
      setMentions([])
      setAttachments([])
      setSubject('')
    })
  }

  const toggle = (list: string[], id: string, on: boolean) => (on ? [...list, id] : list.filter((item) => item !== id))

  return (
    <div className="fw-rp-thread">
      {closed && (
        <Banner
          tone="info"
          title={t('thread.closed.title')}
          action={model.can.manage ? <Button size="sm" onClick={() => actions?.onThreadStatus?.('OPEN')}>{t('thread.reopen')}</Button> : undefined}
        >
          {t(model.can.manage ? 'thread.closed.bodyManage' : 'thread.closed.body')}
        </Banner>
      )}

      {modes.length > 0 && !closed ? (
        <div className="fw-rp-composer">
          {modes.length > 1 ? (
            <SegmentedControl
              ariaLabel={t('composer.modeLabel')}
              size="sm"
              wrap
              value={mode}
              onChange={(value) => setMode(value as ComposerMode)}
              options={[
                { value: 'note', label: t('composer.mode.note'), icon: <Lock size={14} aria-hidden /> },
                { value: 'email', label: t('composer.mode.email', { party: partyName }), icon: <Mail size={14} aria-hidden /> },
              ]}
            />
          ) : null}

          {mode === 'email' && (
            <div className="fw-rp-composer-fields">
              <Field label={t('composer.to')} hint={t('composer.toHint')}>
                <Input value={to} onChange={(event) => setTo(event.target.value)} placeholder={t('composer.toPlaceholder')} autoComplete="off" inputMode="email" />
              </Field>
              <Field label={t('composer.subject')} hint={t(hasMail ? 'composer.subjectHint' : 'composer.subjectFirst')}>
                <Input value={subject} onChange={(event) => setSubject(event.target.value)} />
              </Field>
            </div>
          )}

          <div className="fw-rp-composer-pickers">
            {mode === 'note' && model.people.length > 0 && (
              <Disclosure summary={mentions.length > 0 ? t('composer.mentionsChosen', { count: mentions.length }) : t('composer.mentions')}>
                <fieldset className="fw-rp-checklist">
                  <legend className="fw-rp-legend">{t('composer.mentionsLegend')}</legend>
                  {model.people.map((person) => (
                    <Checkbox key={person.id} label={person.name} checked={mentions.includes(person.id)} onChange={(event) => setMentions((list) => toggle(list, person.id, event.target.checked))} />
                  ))}
                </fieldset>
              </Disclosure>
            )}
            {attachable.length > 0 ? (
              <Disclosure summary={attachments.length > 0 ? t('composer.attachChosen', { count: attachments.length }) : t('composer.attach')}>
                <fieldset className="fw-rp-checklist">
                  <legend className="fw-rp-legend">{t(mode === 'email' ? 'composer.attachLegendEmail' : 'composer.attachLegendNote', { party: partyName })}</legend>
                  {attachable.map((file) => (
                    <Checkbox
                      key={file.id}
                      checked={attachments.includes(file.id)}
                      onChange={(event) => setAttachments((list) => toggle(list, file.id, event.target.checked))}
                      label={
                        <span className="fw-rp-attach-option">
                          <span>{file.name}</span>
                          <span className="fw-rp-muted">{sizeWords(file.sizeBytes, locale)}</span>
                          {audienceBadges(file.visibility).map((badge) => (
                            <Tag key={badge.audience} tone={badge.tone}>
                              {t(badge.key)}
                            </Tag>
                          ))}
                        </span>
                      }
                    />
                  ))}
                </fieldset>
              </Disclosure>
            ) : mode === 'email' && files.length > 0 ? (
              <p className="fw-rp-muted fw-rp-small">{t('composer.noSharedFiles', { party: partyName })}</p>
            ) : null}
          </div>

          <ReplyComposer
            title={mode === 'note' ? t('composer.title.note') : t('composer.title.email', { party: partyName })}
            label={mode === 'note' ? t('composer.title.note') : t('composer.title.email', { party: partyName })}
            ruleLine={mode === 'note' ? t('composer.rule.note', { party: partyName || t('composer.rule.noParty') }) : t('composer.rule.email', { party: partyName })}
            placeholder={mode === 'note' ? t('composer.placeholder.note') : t('composer.placeholder.email')}
            value={body}
            onChange={setBody}
            limit={MAX_BODY_LENGTH}
            primary={{ label: mode === 'note' ? t('composer.send.note') : t('composer.send.email'), onClick: send, heldReason: heldText }}
          />
          {model.can.email && model.party === null && <p className="fw-rp-muted fw-rp-small">{t('composer.absent.noParty')}</p>}
        </div>
      ) : absent && !closed ? (
        <p className="fw-rp-muted fw-rp-small">{t(absent)}</p>
      ) : null}

      {model.can.manage && model.thread?.status === 'OPEN' && (
        <div className="fw-rp-thread-tools">
          <Button size="sm" variant="quiet" onClick={() => actions?.onThreadStatus?.('CLOSED')}>
            {t('thread.close')}
          </Button>
        </div>
      )}

      <MessageList model={model} actions={actions} />
    </div>
  )
}

function MessageList({ model, actions }: { model: RecordPanelsViewModel; actions?: RecordPanelsActions }) {
  const t = useT('records')
  const { items, more, problem } = model.messages
  if (problem) {
    return (
      <Banner tone="danger" title={t(problem)} action={<Button size="sm" onClick={() => actions?.onRetry?.('thread')}>{t('panels.retry')}</Button>} />
    )
  }
  if (items === null) {
    return (
      <p className="fw-rp-loading" role="status">
        <Spinner size={14} /> {t('thread.loading')}
      </p>
    )
  }
  if (items.length === 0) return <EmptyState icon={<MailOpen size={22} aria-hidden />} title={t('thread.empty.title')} description={t('thread.empty.body')} />
  return (
    <>
      <ol className="fw-rp-messages" aria-label={t('thread.listLabel')}>
        {items.map((message) => (
          <MessageItem key={message.id} message={message} model={model} actions={actions} />
        ))}
      </ol>
      {more && (
        <div className="fw-rp-more">
          <Button size="sm" onClick={() => actions?.onMoreMessages?.()}>
            {t('thread.older')}
          </Button>
        </div>
      )}
    </>
  )
}

function MessageItem({ message, model, actions }: { message: PanelMessage; model: RecordPanelsViewModel; actions?: RecordPanelsActions }) {
  const t = useT('records')
  const locale = useLocale()
  const partyName = model.party?.name || t('message.theParty')
  const internal = message.direction === 'INTERNAL_NOTE'
  const author = message.authorName ?? t(`message.author.${message.authorKind}`)
  const kind = internal ? t('message.kind.note') : message.direction === 'OUTBOUND' ? t('message.kind.outbound', { party: partyName }) : t('message.kind.inbound', { party: partyName })
  return (
    <li className={`fw-rp-message ${internal ? 'is-internal' : 'is-shared'}`}>
      <article aria-label={t('message.label', { author, kind })}>
        <header className="fw-rp-message-head">
          <span className="fw-rp-message-author">{author}</span>
          <Tag tone={internal ? 'neutral' : 'info'}>
            {internal ? <Lock size={12} className="fw-rp-tag-icon" aria-hidden /> : message.direction === 'OUTBOUND' ? <Send size={12} className="fw-rp-tag-icon" aria-hidden /> : <Mail size={12} className="fw-rp-tag-icon" aria-hidden />}
            {kind}
          </Tag>
          {message.email && <Tag tone={EMAIL_TONE[message.email.status]}>{t(`message.email.${message.email.status}`)}</Tag>}
          <time className="fw-rp-muted fw-rp-small" dateTime={message.at}>
            {formatDateTime(message.at, { locale })}
          </time>
        </header>
        {message.email && (
          <p className="fw-rp-muted fw-rp-small fw-rp-message-meta">
            {t('message.emailTo', { to: message.email.to.join(', '), subject: message.email.subject })}
          </p>
        )}
        <div className="fw-rp-message-body">{message.body}</div>
        {message.mentions.length > 0 && (
          <p className="fw-rp-muted fw-rp-small fw-rp-message-meta">
            <AtSign size={12} aria-hidden /> {t('message.mentioned', { names: message.mentions.map((name) => name ?? t('message.someone')).join(', ') })}
          </p>
        )}
        {message.attachments.length > 0 && (
          <ul className="fw-rp-message-files" aria-label={t('message.attachments')}>
            {message.attachments.map((file) => (
              <li key={file.id}>
                <Button
                  size="sm"
                  variant="quiet"
                  wrap
                  onClick={() => actions?.onDownload?.(file.id)}
                  heldReason={!model.can.readFiles ? t('files.held.noRead') : file.status !== 'AVAILABLE' ? t('files.held.notAvailable') : null}
                >
                  <Paperclip size={13} aria-hidden /> {file.name} <span className="fw-rp-muted">{sizeWords(file.sizeBytes, locale)}</span>
                </Button>
              </li>
            ))}
          </ul>
        )}
      </article>
    </li>
  )
}
