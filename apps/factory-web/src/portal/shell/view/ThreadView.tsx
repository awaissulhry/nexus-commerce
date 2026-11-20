'use client'

import { Pin } from 'lucide-react'
import { RefPair } from '@nexus/ui/components/RefPair/index'
import { PartnerThread, type PartnerMessage } from '@nexus/ui/patterns/PartnerThread/index'
import { useDsWords } from '../../../lib/i18n/ds-parts'
import { useT } from '../../../lib/i18n/provider'
// F-CP-156: "Ask <name>, factory designer" under the thread (the DS PartnerThread unchanged).
import { AtSign } from 'lucide-react'
import { Checkbox, FilterChip } from '@nexus/ui/primitives'
// F-CP-156 (cp-fx14, walk L3): the held box says why beside it (a lock and the words), never a disabled grey.
import { Lock } from 'lucide-react'
import { useId } from 'react'

/**
 * Ask a question / Messages (design portal.frame › thread; COL-059, COL-060): ONE conversation per record, shared with us —
 * our messages and files and theirs, never an internal note; a reply by e-mail lands in the same thread and the composer
 * says so ("You can also answer our e-mails"). When the person may not write, the reason in place of the box and one line
 * that says who can (design access-rules). The DS PartnerThread draws it (oldest first, plain text, Ctrl / ⌘ + Enter sends).
 */

export interface ThreadViewModel {
  state: 'loading' | 'error' | 'ready'
  title?: string
  /** The record: their reference first, ours second. Null: the account (a question with no record). */
  record: { theirs: string | null; ours: string | null } | null
  companyName: string
  /** Oldest first. */
  messages: readonly PartnerMessage[]
  composer: { value: string; busy: boolean; heldReason: string | null; hint: string | null; limit: number } | null
  loadMore: { busy: boolean } | null
  /** Who can do what this person cannot ("Ask your admin, Anna Rossi, …"); null: nothing to say. */
  accessLine: string | null
  /** The last post failed, in words (the typed text stays). */
  failed: string | null
  /** B-TH-286 (B-TH-091): the messages pinned for everyone on the record that this customer may read; empty: no line. */
  pins?: readonly { readonly id: string; readonly author: string | null; readonly words: string; readonly date: string }[]
  /**
   * F-CP-156 (customer page plan C7, D12): "Ask <name>, factory designer" — the one name the customer may ask, whether the box is
   * ticked, whether the ONE "@" chip shows (an "@" being typed), why it cannot be ticked now (words), or null: no box (no name, or a
   * record the customer cannot ask on). Never who read it.
   */
  designer?: { readonly name: string; readonly ask: boolean; readonly chip: boolean; readonly held: string | null } | null
}

export interface ThreadViewProps {
  model: ThreadViewModel
  onChange?: (value: string) => void
  onSend?: () => void
  onMore?: () => void
  onRetry?: () => void
  headingLevel?: 2 | 3
  /** F-CP-156: the box ticked or not; the "@" chip pressed (the name goes into the text and the box is ticked). */
  onAskDesigner?: (ask: boolean) => void
  onDesignerChip?: () => void
}

export function ThreadView({ model, onChange, onSend, onMore, onRetry, headingLevel = 2, onAskDesigner, onDesignerChip }: ThreadViewProps) {
  const t = useT('portal')
  const ds = useDsWords()
  const pins = model.pins ?? []
  // F-CP-156 (cp-fx14, walk L3): the box's held words (null: it may be ticked) and the id the box is described by.
  const held = model.designer?.held ?? null
  const hintId = useId()
  return (
    <div className="fw-pthread">
      {/* B-TH-286 (T2-F07): what was pinned on this record, above the conversation; nothing when nothing is pinned (T2-F09). */}
      {pins.length > 0 && (
        <section className="fw-pthread-pins" aria-label={t('thread.pins.title', { count: pins.length })}>
          <p className="fw-pthread-pins-title">
            <Pin size={13} aria-hidden /> {t('thread.pins.title', { count: pins.length })}
          </p>
          <ul className="fw-pthread-pins-list">
            {pins.map((pin) => (
              <li key={pin.id}>
                <span className="fw-pthread-pins-words">{pin.words}</span>
                <span className="fw-pthread-pins-meta">{[pin.author ?? model.companyName, pin.date].join(' · ')}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <PartnerThread
        title={model.title ?? t('thread.title')}
        headingLevel={headingLevel}
        record={model.record ? <RefPair theirs={model.record.theirs} ours={model.record.ours} size="sm" labels={ds.refPair} /> : undefined}
        companyName={model.companyName}
        messages={model.messages}
        state={model.state}
        onRetry={onRetry}
        empty={model.record ? t('thread.empty') : t('thread.emptyAccount')}
        loadMore={model.loadMore && onMore ? { onClick: onMore, busy: model.loadMore.busy } : null}
        composer={
          model.composer
            ? {
                value: model.composer.value,
                onChange: (value) => onChange?.(value),
                onSend: () => onSend?.(),
                busy: model.composer.busy,
                heldReason: model.composer.heldReason,
                hint: model.composer.hint,
                limit: model.composer.limit,
              }
            : null
        }
        labels={ds.partnerThread}
        textareaLabels={ds.textarea}
      />
      {/* F-CP-156: under the DS thread — the ONE "@" chip while an "@" is typed, then the box and its hint. */}
      {model.designer && model.composer ? (
        <div className="fw-pthread-designer" data-held={held !== null ? '' : undefined}>
          {model.designer.chip ? (
            <FilterChip className="fw-pthread-designer-chip" onClick={() => onDesignerChip?.()}>
              <AtSign size={12} aria-hidden /> {t('thread.designer.chip', { name: model.designer.name })}
            </FilterChip>
          ) : null}
          {/* F-CP-156 (cp-fx14, walk L3): held, not disabled — the box stays focusable with a readable label, says why in words
              beside it (aria-describedby) and does not change; the DS Checkbox has no held state (packages/ui as it is). */}
          <Checkbox
            checked={model.designer.ask}
            aria-disabled={held !== null ? true : undefined}
            aria-describedby={hintId}
            onChange={(event) => {
              if (held === null) onAskDesigner?.(event.target.checked)
            }}
            label={<strong>{t('thread.designer.ask', { name: model.designer.name })}</strong>}
          />
          <p className="fw-pthread-designer-hint" id={hintId}>
            {held !== null ? (
              <>
                <Lock size={12} aria-hidden /> <span>{held}</span>
              </>
            ) : (
              `${t('thread.designer.hint', { name: model.designer.name })} ${t('thread.designer.typeAt', { name: model.designer.name })}`
            )}
          </p>
        </div>
      ) : null}
      {model.failed ? (
        <p className="fw-pdialog-failed" role="alert">
          {model.failed}
        </p>
      ) : null}
      {model.accessLine ? <p className="fw-paccess-line">{model.accessLine}</p> : null}
    </div>
  )
}
