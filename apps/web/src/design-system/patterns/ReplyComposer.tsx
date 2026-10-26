'use client'

import { useId, type ReactNode } from 'react'
import { ChevronDown, ExternalLink, Languages, Sparkles } from 'lucide-react'
import { Button } from '../primitives/Button'
import { Pill } from '../primitives/Pill'
import { Spinner } from '../primitives/Spinner'
import { Textarea } from '../primitives/Textarea'
import { Banner } from '../components/Banner'
import { Menu, type MenuItemDef } from '../components/Menu'
import { replyHeldReason, replyLengthWords } from './replyComposerModel'

export interface ReplyTemplate {
  id: string
  label: string
  body: string
  /** A second line in the menu ("Fit & sizing · Italian, German"). */
  description?: string
}

export interface ReplyAction {
  label: ReactNode
  onClick?: () => void
  /** A link instead of a button ("Open in Seller Central"). */
  href?: string
  /** Opens in a new tab, with an external-link mark. */
  external?: boolean
}

export interface ReplyComposerProps {
  value: string
  onChange: (value: string) => void
  /** The channel's limit in characters (eBay 500), or null when it states none. */
  limit: number | null
  /** The channel's reply rule in words ("One reply per feedback, up to 500 characters, can't be edited or removed."). */
  ruleLine: ReactNode
  /** The heading. Default "Reply". */
  title?: ReactNode
  /** The section's accessible name ("Reply on eBay to Marco R."). Default "Reply". */
  label?: string
  placeholder?: string
  /** Saved replies, in a Templates menu. */
  templates?: ReplyTemplate[]
  /** A template was picked. Default: its body replaces the text. */
  onTemplate?: (id: string) => void
  /** "Draft with AI" — in the buyer's language; `englishLine` is the English meaning, shown only to us. */
  draft?: { onDraft: () => void; busy: boolean; heldReason?: string | null; englishLine?: string | null }
  /** The main action ("Send reply to eBay", "Copy reply"). Held with the first reason that applies (see the model). */
  primary?: { label: string; onClick: () => void; heldReason?: string | null; busy?: boolean }
  /** Other actions, before the main one ("Save draft", "Open in Seller Central"). */
  secondary?: ReplyAction[]
  /** The reply went out: shown read-only with when and what that means ("public on eBay · cannot be undone"). */
  sent?: { at: string; text: string; note: string } | null
  /** The channel refused the reply, in words ("eBay refused the reply: this feedback already has one. Nothing was sent."). */
  refused?: string | null
  /** Where the reply window stands ("Day 2 of 100"). */
  window?: string | null
}

/**
 * One reply box for every channel (Reviews parts, 2026-10-26). Channel-agnostic: the page passes the channel's limit and
 * rule line, and the actions it allows (send through the API, or copy and open the channel). The text field counts with
 * the Textarea counter (it never blocks typing); the main action is HELD — focusable, says why — when the page says so
 * (no permission), when the reply was sent, when the text is over the limit ("Cut 38 characters…") or empty. A sent reply
 * is read-only. The layout is `.nds-reply*` in patterns.css.
 */
export function ReplyComposer({
  value, onChange, limit, ruleLine, title = 'Reply', label = 'Reply', placeholder = 'Write a reply, pick a template or draft one with AI',
  templates, onTemplate, draft, primary, secondary, sent, refused, window: replyWindow,
}: ReplyComposerProps) {
  const id = `${useId()}-reply`
  const isSent = sent != null
  const held = primary ? replyHeldReason({ held: primary.heldReason, sent: isSent, text: value, limit }) : null
  const sending = !!primary?.busy

  const templateItems: MenuItemDef[] = (templates ?? []).map(t => ({
    id: t.id,
    label: t.label,
    description: t.description,
    onSelect: () => (onTemplate ? onTemplate(t.id) : onChange(t.body)),
  }))

  const actions = (
    <>
      {(secondary ?? []).map((action, i) => action.href ? (
        <Button key={i} size="sm" asChild>
          <a href={action.href} target={action.external ? '_blank' : undefined} rel={action.external ? 'noopener noreferrer' : undefined}>
            {action.label}
            {action.external && <ExternalLink size={13} aria-hidden focusable={false} />}
          </a>
        </Button>
      ) : (
        <Button key={i} size="sm" variant="ghost" onClick={action.onClick}>{action.label}</Button>
      ))}
      {primary && !isSent && (
        <Button
          size="sm"
          variant="primary"
          onClick={primary.onClick}
          heldReason={sending ? 'This takes a few seconds.' : held}
        >
          {sending && <Spinner size={13} />}
          {primary.label}
        </Button>
      )}
    </>
  )

  return (
    <section className="nds-reply" aria-label={label}>
      <div className="nds-reply-head">
        <h3 className="nds-reply-title">{title}</h3>
        {replyWindow && <Pill tone="info">{replyWindow}</Pill>}
        <span className="grow" />
        {!isSent && templateItems.length > 0 && (
          <Menu
            label={<>Templates <ChevronDown size={14} aria-hidden /></>}
            items={templateItems}
            align="right"
            triggerProps={{ className: 'nds-btn sm' }}
          />
        )}
        {!isSent && draft && (
          <Button size="sm" onClick={draft.onDraft} heldReason={draft.busy ? 'Drafting a reply… this takes a few seconds.' : draft.heldReason}>
            {draft.busy ? <Spinner size={13} /> : <Sparkles size={14} aria-hidden focusable={false} />}
            Draft with AI
          </Button>
        )}
      </div>
      <p className="nds-reply-rule">{ruleLine}</p>
      {refused && <Banner tone="danger" title={refused} />}
      {isSent ? (
        <div className="nds-reply-sent">
          <div className="nds-reply-sent-text">{sent.text}</div>
          <div className="nds-reply-sent-meta" role="status">
            <Pill tone="success" dot>Sent</Pill>
            <span>{sent.at}</span>
            <span>{sent.note}</span>
          </div>
        </div>
      ) : (
        <>
          <label className="nds-vh" htmlFor={id}>Reply text</label>
          <Textarea
            id={id}
            className="nds-reply-text"
            rows={4}
            value={value}
            onChange={event => onChange(event.target.value)}
            limit={limit ?? undefined}
            readOnly={sending}
            aria-busy={sending || undefined}
            placeholder={placeholder}
          />
          {draft?.englishLine && (
            <div className="nds-reply-translation">
              <span className="lbl"><Languages size={13} aria-hidden focusable={false} /> In English, only for you</span>
              <span lang="en">{draft.englishLine}</span>
            </div>
          )}
        </>
      )}
      {(primary || (secondary?.length ?? 0) > 0) && (
        <div className="nds-reply-foot">
          {!isSent && limit == null && <span className="nds-reply-count" aria-live="polite">{replyLengthWords(value)}</span>}
          <span className="grow" />
          {actions}
        </div>
      )}
    </section>
  )
}
