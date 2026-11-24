'use client'

import { FileText, Files, ImageIcon, Lock } from 'lucide-react'
import { useLocale, useT } from '../../../i18n/provider'
import { timeOf } from '../../parts/time'
import { toneClass, type SenderTone } from '../../parts/tones'
import type { CardLink } from '../model'
import { quoteOf, type QuoteMedia } from '../quote'

const MEDIA_ICON: Readonly<Record<QuoteMedia, typeof ImageIcon>> = { photo: ImageIcon, pdf: FileText, file: FileText, files: Files }

/**
 * tw- W1.2 (10-design §5, §6; W-030 / W-031 / W-032): the quote at the top of a reply — a 4 px bar and the quoted sender's name in
 * their colour ("You" for the reader's own, a small lock after a quoted office note), then 1 to 3 lines of their words, or an icon
 * and a word for their files ("Photo", "PDF", "File", "2 files"; no thumbnail this round, Z1), or "Message removed" with no name. It is a
 * button: a click (or Enter on it) goes to the message it quotes (`onJump`: the host loads older pages if it must, then lights the
 * row). Drawn from the reply's OWN link only (R1) — never a look-up among the loaded messages; words only, never an amount.
 */
export function QuoteBlock({ link, onJump, tones }: { link: CardLink; onJump?: ((messageId: string) => void) | undefined; /* tw- fx2 (G-7) */ tones?: ReadonlyMap<string, SenderTone> | undefined }) {
  const t = useT('record-thread-card')
  const locale = useLocale()
  const own = quoteOf(link)
  // tw- fx2 (G-7): the quoted person's colour in THIS list (a slate quote — removed, hidden — stays slate).
  const quote = own.tone !== 'slate' && link.senderKey && tones?.get(link.senderKey) ? { ...own, tone: tones.get(link.senderKey)! } : own
  const name = quote.name === null ? null : 'text' in quote.name ? quote.name.text : t(quote.name.key)
  const text = 'text' in quote.text ? quote.text.text : t(quote.text.key, quote.text.count === undefined ? undefined : { count: quote.text.count })
  const Icon = quote.media ? MEDIA_ICON[quote.media] : null
  const inner = (
    <>
      <span className="fw-rt-quote-bar" aria-hidden="true" />
      <span className="fw-rt-quote-body">
        {name !== null && (
          <span className="fw-rt-quote-name">
            <span>{name}</span>
            {quote.lock && <Lock size={12} aria-hidden />}
          </span>
        )}
        <span className={`fw-rt-quote-text${quote.lines === 1 ? ' is-one' : ''}${quote.removed ? ' is-gone' : ''}`}>
          {Icon && <Icon size={13} aria-hidden />}
          {text}
        </span>
      </span>
    </>
  )
  const cls = `fw-rt-quote ${toneClass(quote.tone)}`
  if (!onJump) return <div className={cls}>{inner}</div>
  return (
    <button type="button" className={cls} aria-label={t('quote.label', { who: name ?? t('quote.removed'), time: timeOf(link.at, locale) })} onClick={() => onJump(link.id)}>
      {inner}
    </button>
  )
}
