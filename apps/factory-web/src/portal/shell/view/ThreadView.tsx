'use client'

import { RefPair } from '@nexus/ui/components/RefPair/index'
import { PartnerThread, type PartnerMessage } from '@nexus/ui/patterns/PartnerThread/index'
import { useDsWords } from '../../../lib/i18n/ds-parts'
import { useT } from '../../../lib/i18n/provider'

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
}

export interface ThreadViewProps {
  model: ThreadViewModel
  onChange?: (value: string) => void
  onSend?: () => void
  onMore?: () => void
  onRetry?: () => void
  headingLevel?: 2 | 3
}

export function ThreadView({ model, onChange, onSend, onMore, onRetry, headingLevel = 2 }: ThreadViewProps) {
  const t = useT('portal')
  const ds = useDsWords()
  return (
    <div className="fw-pthread">
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
      {model.failed ? (
        <p className="fw-pdialog-failed" role="alert">
          {model.failed}
        </p>
      ) : null}
      {model.accessLine ? <p className="fw-paccess-line">{model.accessLine}</p> : null}
    </div>
  )
}
