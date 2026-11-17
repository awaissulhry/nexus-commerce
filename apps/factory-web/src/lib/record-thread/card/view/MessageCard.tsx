'use client'

import { useId, useState, type ReactNode } from 'react'
import { Globe, ImageIcon, Lock, Mail, MoreHorizontal, RotateCw, Tablet, Trash2 } from 'lucide-react'
import { Menu } from '@nexus/ui/components'
import { Button, Pill } from '@nexus/ui/primitives'
import { FileRow } from '../../../i18n/ds-parts'
import { INTL_LOCALE } from '../../../i18n/locales'
import { useLocale, useT } from '../../../i18n/provider'
import { Avatar } from '../../parts/Avatar'
import { timeOf } from '../../parts/time'
import {
  audienceKey,
  authorWords,
  cardActions,
  cardFiles,
  cardMarks,
  DELIVERY_TONE,
  fileKindKey,
  longFold,
  sideKey,
  sizeWords,
  splitQuoted,
  type CardContext,
  type CardMessage,
} from '../model'
import '../card.css'

export interface CardActions {
  onReply?: (messageId: string) => void
  onTask?: (messageId: string) => void
  onCopyLink?: (messageId: string) => void
  /** Send again a message that did not go (the same Idempotency-Key: one message). */
  onRetry?: (messageId: string) => void
  onOpenFile?: (fileId: string) => void
  /** "+14": the message's other files (the Files view, TH-1c); without it the card shows them all in place. */
  onMoreFiles?: (messageId: string) => void
}

const MARK_ICON = { lock: Lock, mail: Mail, globe: Globe, tablet: Tablet } as const
const MAX_NAMES = 10

/**
 * One message of a record's thread (B-TH-298, T3; picture 2): a full-width card that says its side and audience in words and
 * colour, its writer and time, at most two marks in the head and the rest in a small details line, the text at ~72 characters a
 * line (quoted text and the signature behind "…", a long mail folded after 12 lines), its files, and the ⋯ menu. An article named
 * by writer, side, audience and time for screen readers. Draws its model only.
 */
export function MessageCard({ message, context, actions, remind }: { message: CardMessage; context: CardContext; actions?: CardActions; remind?: ReactNode }) {
  const t = useT('record-thread-card')
  const locale = useLocale()
  const intl = INTL_LOCALE[locale]
  const quotedId = useId()
  const [quotedOpen, setQuotedOpen] = useState(false)
  const [allShown, setAllShown] = useState(false)
  const [allFiles, setAllFiles] = useState(false)

  const party = context.partyName || t('side.theParty')
  const who = authorWords(message)
  const author = 'text' in who ? who.text : t(who.key)
  const side = sideKey(message.kind)
  const sideText = side === 'side.theirs' ? party : side ? t(side) : null
  const time = timeOf(message.at, locale)
  const { text, quoted } = splitQuoted(message.body, message.kind)
  const fold = longFold(text)
  const folded = fold.folds && !allShown
  const files = cardFiles(message.files, context.canReadFiles, allFiles)
  const menu = cardActions(message, context)
  const failed = message.outbox?.state === 'failed'
  const sending = message.outbox?.state === 'sending'
  const names = message.mentions.map((name) => name ?? t('author.someone'))

  const label = t('label', { author, audience: t(audienceKey(message), { party }), time })
  const cls = ['fw-rt-msg', `is-${message.kind}`, sending ? 'is-pending' : '', failed ? 'is-failed' : '', context.anchorId === message.id ? 'is-anchor' : ''].filter(Boolean).join(' ')

  return (
    <article className={cls} id={`message-${message.id}`} data-message-id={message.id} data-feed-item={message.id} tabIndex={-1} aria-label={label}>
      <div className="fw-rt-msg-head">
        <Avatar name={message.kind === 'theirs' ? party : message.authorHidden ? null : message.author} kind={message.kind === 'theirs' ? 'organisation' : 'person'} />
        <span className="fw-rt-who">{author}</span>
        {sideText && <span className="fw-rt-side">{sideText}</span>}
        {cardMarks(message).map((mark) => {
          const Icon = MARK_ICON[mark.icon]
          return (
            <span key={mark.key} className="fw-rt-mark">
              <Icon size={13} aria-hidden />
              {t(mark.key, { party })}
            </span>
          )
        })}
        {message.email && !message.outbox && (
          <Pill tone={DELIVERY_TONE[message.email.status]}>{t(`delivery.${message.email.status}`)}</Pill>
        )}
        <span className="fw-rt-msg-end">
          <time dateTime={message.at}>{time}</time>
          {!message.outbox && remind}
          {menu.length > 0 && (
            <Menu
              align="right"
              className="fw-rt-msg-menu"
              label={<MoreHorizontal size={15} aria-hidden />}
              triggerProps={{ 'aria-label': t('menu.label', { author, time }), className: 'nds-btn quiet sm fw-rt-msg-more' }}
              items={menu.map((action) => ({
                id: action,
                label: t(`menu.${action}`),
                description: t(`menu.${action}Hint`),
                onSelect: () => {
                  if (action === 'reply') actions?.onReply?.(message.id)
                  if (action === 'task') actions?.onTask?.(message.id)
                  if (action === 'link') actions?.onCopyLink?.(message.id)
                },
              }))}
            />
          )}
        </span>
      </div>

      <p className={`fw-rt-body${folded ? ' is-folded' : ''}`}>{text}</p>
      {fold.folds && !allShown && (
        <button type="button" className="fw-rt-showall" onClick={() => setAllShown(true)}>
          {t('body.showAll', { count: fold.lines })}
        </button>
      )}
      {quoted !== null && (
        <>
          <button type="button" className="fw-rt-quoted" aria-expanded={quotedOpen} aria-controls={quotedId} aria-label={t(quotedOpen ? 'body.hideQuoted' : 'body.showQuoted')} onClick={() => setQuotedOpen((open) => !open)}>
            …
          </button>
          <p id={quotedId} className="fw-rt-quoted-text" hidden={!quotedOpen}>
            {quoted}
          </p>
        </>
      )}

      {message.kind === 'note' && names.length > 0 && (
        <p className="fw-rt-details">
          {names.length > MAX_NAMES ? t('mentioned.more', { names: names.slice(0, 2).join(', '), count: names.length - 2 }) : t('mentioned.list', { names: names.join(', ') })}
        </p>
      )}

      {(files.photos.length > 0 || files.others.length > 0 || files.held.length > 0 || files.more > 0 || files.hidden > 0) && (
        <div className="fw-rt-attach">
          {(files.photos.length > 0 || files.more > 0) && (
            <ul className="fw-rt-photos" aria-label={t('files.label')}>
              {files.photos.map((file) => (
                <li key={file.id} className="fw-rt-photo">
                  <button type="button" aria-label={t('files.open', { name: file.name })} onClick={() => actions?.onOpenFile?.(file.id)}>
                    <ImageIcon size={22} aria-hidden />
                  </button>
                  <span title={file.name}>{file.name}</span>
                </li>
              ))}
              {files.more > 0 && (
                <li className="fw-rt-photo">
                  <button type="button" className="fw-rt-photo-more" aria-label={t('files.moreLabel', { count: files.more })} onClick={() => (actions?.onMoreFiles ? actions.onMoreFiles(message.id) : setAllFiles(true))}>
                    +{files.more}
                  </button>
                  <span>{t('files.more', { count: files.more })}</span>
                </li>
              )}
            </ul>
          )}
          {files.others.map((file) => (
            <FileRow
              key={file.id}
              name={file.name}
              size={file.sizeBytes}
              status={`${t(fileKindKey(file))} · ${sizeWords(file.sizeBytes, intl)}`}
              actions={
                <Button size="sm" variant="quiet" onClick={() => actions?.onOpenFile?.(file.id)} aria-label={t('files.open', { name: file.name })}>
                  {t('files.openShort')}
                </Button>
              }
            />
          ))}
          {files.held.map((file) => (
            <p key={file.id} className="fw-rt-held-file">
              {file.status === 'DELETED' ? <Trash2 size={13} aria-hidden /> : <Lock size={13} aria-hidden />}
              <span>
                <b>{file.name}</b> · {t(file.status === 'DELETED' ? 'files.removed' : file.status === 'QUARANTINED' ? 'files.quarantined' : 'files.pending')}
              </span>
            </p>
          ))}
          {files.hidden > 0 && (
            <p className="fw-rt-held-file">
              <Lock size={13} aria-hidden />
              <span>{t('files.cannotOpen', { count: files.hidden })}</span>
            </p>
          )}
        </div>
      )}

      {message.email && message.kind === 'ours' && (
        <p className="fw-rt-details">{t('details.email', { to: message.email.to.join(', '), subject: message.email.subject })}</p>
      )}

      {message.email?.status === 'BOUNCED' && (
        <p className="fw-rt-bounce" role="note">
          <span>{t('bounce.text', { to: message.email.to.join(', ') })}</span>
          {message.bounceTask && (
            <a className="fw-rt-bounce-link" href={message.bounceTask.href}>
              {t('bounce.task')}
            </a>
          )}
        </p>
      )}
      {message.email?.status === 'COMPLAINED' && (
        <p className="fw-rt-bounce" role="note">
          {t('bounce.complained')}
        </p>
      )}
      {message.email?.status === 'FAILED' && (
        <p className="fw-rt-bounce" role="note">
          {t('bounce.failed')}
        </p>
      )}

      {sending && <p className="fw-rt-details">{t('outbox.sending')}</p>}
      {message.outbox?.state === 'failed' && (
        <p className="fw-rt-failline" role="alert">
          <span>{t('outbox.failed', { reason: t(message.outbox.reason) })}</span>
          <Button size="sm" onClick={() => actions?.onRetry?.(message.id)}>
            <RotateCw size={13} aria-hidden /> {t('outbox.retry')}
          </Button>
        </p>
      )}
    </article>
  )
}
