'use client'

import { useMemo, useRef, useState, type ReactNode } from 'react'
import { Mail } from 'lucide-react'
import { Banner } from '@nexus/ui/components'
import { messagesFor } from '../../../i18n/messages'
import { I18nProvider, useLocale, useT } from '../../../i18n/provider'
import { excerptOf } from '../../card/model'
import { FootIcon, MessageRow } from '../../card/view/MessageRow'
import { feedRows } from '../../feed/model'
import { useFeedShell } from '../../feed/use-feed-shell'
import { dayText, DayRow, FeedEmpty, FeedFailed, FeedLoading, FeedShell, UnreadRow } from '../../feed/view/FeedShell'
import { PinnedBar } from '../../head/view/PinnedBar'
import { THREAD_NAMESPACES } from '../../parts/ThreadMessages'
import { dayOf, timeOf } from '../../parts/time'
import { tonesFor } from '../../parts/tones'
import { partnerFeedOf, partnerMenuOf, partnerPinsOf, partnerRowOf, partnerWho, type PartnerFeedMessage, type PartnerKind, type PartnerNames, type PortalPin, type PortalThreadMessage } from '../model'
import { PartnerComposer, type PartnerComposerActions, type PartnerComposerModel } from './PartnerComposer'
import { PartnerHead, type PartnerWidth } from './PartnerHead'
import '../../record-thread.css'
import '../partner.css'

/** The face's catalogues: the thread's own, the head's, the partner's. */
const PARTNER_NS = [...THREAD_NAMESPACES, 'record-thread-head', 'record-thread-partner']

export interface PartnerColumnModel {
  /** record: a record's messages; account: the account's; link: a link's guest (no Reply, no quote, the "+" of shared files). */
  readonly kind: PartnerKind
  readonly state: 'loading' | 'error' | 'ready'
  /** The head's title, the host's ("Messages", "Ask us a question"). */
  readonly title: string
  /** What the column is named by ("Your order 142", the account's name). */
  readonly recordName: string
  /** Our company: its name on our unnamed messages and beside our people's. */
  readonly companyName: string
  /** Oldest first. */
  readonly messages: readonly PortalThreadMessage[]
  /** Older messages exist (the top of the list reads the next page as the person scrolls up), and how that read goes. */
  readonly more?: boolean | undefined
  readonly older?: 'idle' | 'loading' | 'failed' | undefined
  /** The reader's own reading on arrival: the band above the first new message, the list opening there. */
  readonly reading?: { readonly firstNewId: string | null; readonly newCount: number } | null | undefined
  /** The row a jump lights up (the host's: `seq` restarts it). */
  readonly flash?: { readonly id: string; readonly seq: number } | null | undefined
  readonly pins?: readonly PortalPin[] | undefined
  /** The box; null: a page that only reads. */
  readonly composer: Omit<PartnerComposerModel, 'reply'> | null
  /** The message the box answers (its bar), or null. */
  readonly replyTo?: string | null | undefined
  /** The host's long sentences for the ⓘ ("You can also answer our emails…", the designer's rule, price talk). */
  readonly help?: readonly string[] | undefined
  /** The last act failed, in the host's words (the box keeps its text). */
  readonly notice?: string | null | undefined
  /** The frame's width chooser; absent: the ⋮ is not drawn (A11). */
  readonly width?: PartnerWidth | null | undefined
  /** "Now" for the day pills (ISO); absent: the clock. */
  readonly now?: string | undefined
}

export interface PartnerColumnActions extends PartnerComposerActions {
  /** Reply on a message (its menu, or R on it): the box answers it. */
  readonly onReply?: ((messageId: string) => void) | undefined
  /** A quote or a pin: to the message (the host reads older pages if it must, then lights the row). */
  readonly onJump?: ((messageId: string) => void) | undefined
  /** The next older page (the top of the list as the person scrolls up), and its Retry. */
  readonly onOlder?: (() => void) | undefined
  /** The read failed: Try again. */
  readonly onRetry?: (() => void) | undefined
  readonly onDismissNotice?: (() => void) | undefined
}

/**
 * pt-w2 W2.2 (lane pt-, S1, S6–S8; 10-design §1 – §8): THE partner face — the office's thread with fewer things, drawn from the SAME
 * parts: ONE card (`section.fw-rt-column`) with ONE head row (title · ⓘ · ⋮ only with a width chooser), the pinned bar (shared pins,
 * never who pinned), the list (the shared list shell: day pills, the ONE unread band, open at it or at the newest, older pages on
 * scroll, the round down button with its count, J / K, R, the jump's flash) of shared rows (MessageRow: tile, bubble, name, the quote
 * from the message's own link, files, words, the foot with the time and a mail icon on emails), the one-row composer (ComposerRow).
 * No office note, no audience chip, no ticks, no "read by", no who pinned: the model has none of them. Every customer, supplier,
 * workshop, accountant and link guest reads this one card; a `kind` picks its word set (and Reply, quotes, the "+").
 */
export function PartnerColumn({ model, actions }: { model: PartnerColumnModel; actions?: PartnerColumnActions | undefined }): ReactNode {
  return (
    <PartnerMessages>
      <Column model={model} actions={actions} />
    </PartnerMessages>
  )
}

/** The face's catalogues added to the page's, in its language (as ThreadMessages does for the office's parts). */
function PartnerMessages({ children }: { children?: ReactNode }): ReactNode {
  const locale = useLocale()
  const messages = useMemo(() => messagesFor(locale, PARTNER_NS), [locale])
  return (
    <I18nProvider locale={locale} messages={messages}>
      {children}
    </I18nProvider>
  )
}

function Column({ model, actions }: { model: PartnerColumnModel; actions?: PartnerColumnActions | undefined }): ReactNode {
  const words = useT('record-thread-partner')
  const card = useT('record-thread-card')
  const feedWords = useT('record-thread-feed')
  const locale = useLocale()
  const column = useRef<HTMLElement>(null)
  const [copied, setCopied] = useState('')
  const names: PartnerNames = useMemo(() => ({ you: words('you'), yourTeam: words('yourTeam'), company: model.companyName }), [words, model.companyName])
  const quotes = model.kind !== 'link'
  const canReply = quotes && model.composer !== null && model.composer.held === null
  const feed = useMemo(() => partnerFeedOf(model.messages, names, { quotes }), [model.messages, names, quotes])
  // tw- fx2 (G-7): one colour per person inside this list (side + name: the read has no person id).
  const tones = useMemo(() => tonesFor(feed.map((message) => message.senderKey)), [feed])
  const firstNewId = model.reading?.firstNewId ?? null
  const newSince = model.reading?.newCount ?? 0
  const rows = useMemo(() => (model.state === 'ready' ? feedRows({ messages: feed, events: [], firstNewId, newCount: newSince }) : []), [model.state, feed, firstNewId, newSince])
  const today = dayOf(model.now ?? new Date().toISOString())
  const shell = useFeedShell(
    { state: model.state, messages: feed, context: {}, more: model.more === true, older: model.older ?? 'idle', newSince, flash: model.flash ?? null },
    rows,
    { onOlder: actions?.onOlder, onReply: actions?.onReply ? (id) => reply(id) : undefined },
    () => canReply,
  )
  const focusBox = () => requestAnimationFrame(() => column.current?.querySelector<HTMLTextAreaElement>('textarea.fw-rt-cx-text')?.focus())
  const reply = (messageId: string) => {
    actions?.onReply?.(messageId)
    focusBox()
  }
  const open = (fileId: string) => {
    const href = model.messages.flatMap((message) => message.attachments ?? []).find((file) => file.id === fileId)?.href
    if (href) window.open(href, '_blank', 'noopener,noreferrer')
  }
  const copy = (message: PartnerFeedMessage) => {
    void navigator.clipboard
      ?.writeText(message.source.body)
      .then(() => setCopied(words('copied')))
      .catch(() => undefined)
  }

  const pins = useMemo(() => partnerPinsOf(model.pins ?? [], names, new Set(model.messages.filter((message) => message.author.mine).map((message) => message.id))), [model.pins, names, model.messages])
  // The reply bar: the message the box answers, said as its quote would say it (the author rule, one line, the person's colour).
  const target = model.replyTo ? feed.find((message) => message.id === model.replyTo) : undefined
  const replyBar = target ? { who: partnerWho(target.source, names), line: target.source.erased ? card('quote.removed') : excerptOf(target.source.body), tone: tones.get(target.senderKey) ?? 'slate', at: target.at } : null

  const label = words(`kind.${model.kind}`, { record: model.recordName })
  const body =
    model.state === 'loading' ? (
      <FeedLoading />
    ) : model.state === 'error' ? (
      <FeedFailed onRetry={actions?.onRetry} />
    ) : (
      <FeedShell
        shell={shell}
        model={{ more: model.more === true, older: model.older ?? 'idle' }}
        empty={model.messages.length === 0 ? <FeedEmpty /> : null}
        rows={rows.map((row) => {
          if (row.kind === 'day') return <DayRow key={row.key} words={dayText(row.day, today, locale, feedWords)} />
          if (row.kind === 'new') return <UnreadRow key={row.key} count={row.count} t={feedWords} />
          if (row.kind !== 'message') return null
          const message = row.message
          const time = timeOf(message.at, locale)
          const who = partnerWho(message.source, names)
          const email = message.source.channel === 'email'
          return (
            <div key={row.key} className="fw-rt-feed-item" data-day={dayText(dayOf(message.at), today, locale, feedWords)}>
              <MessageRow
                message={partnerRowOf(message, { names, tones, label: words(email ? 'row.labelEmail' : 'row.label', { who, time }) })}
                context={{ tones }}
                actions={{ onJump: quotes ? actions?.onJump : undefined, onOpenFile: open }}
                run={row.run}
                flash={shell.flashOf(message.id)}
                menu={{ rows: partnerMenuOf(message.source, { reply: canReply && Boolean(actions?.onReply) }), onPick: (action) => (action === 'reply' ? reply(message.id) : action === 'copyText' ? copy(message) : undefined) }}
                // The portal's foot: a mail on an email only — never a lock, a globe or a tick (everything here is in the portal).
                foot={{ marks: email ? <FootIcon word={card('foot.email')} icon={<Mail size={13} aria-hidden />} /> : null }}
              />
            </div>
          )
        })}
      />
    )

  return (
    <section ref={column} className="fw-rt-column is-docked fw-rtp" data-kind={model.kind} aria-label={label}>
      <PartnerHead title={model.title} label={label} help={model.help ?? []} quotes={quotes} width={model.width} />
      {model.state === 'ready' && pins.length > 0 ? <PinnedBar pins={pins} onJump={quotes ? actions?.onJump : undefined} /> : null}
      {model.notice ? (
        <div className="fw-rt-notice" role="alert">
          <Banner tone="danger" onDismiss={actions?.onDismissNotice}>
            {model.notice}
          </Banner>
        </div>
      ) : null}
      {body}
      {model.composer ? (
        <PartnerComposer
          model={{ ...model.composer, reply: replyBar, ...(model.now ? { now: model.now } : {}) }}
          actions={{
            ...actions,
            onEscape: () => {
              actions?.onEscape?.()
              column.current?.querySelector<HTMLElement>('.fw-rt-feed')?.focus()
            },
          }}
        />
      ) : null}
      <p className="fw-rt-sr" aria-live="polite">
        {copied}
      </p>
    </section>
  )
}
