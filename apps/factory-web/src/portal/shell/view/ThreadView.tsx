'use client'

import type { ReactNode } from 'react'
import { useT } from '../../../lib/i18n/provider'
import type { PartnerKind, PortalThreadMessage } from '../../../lib/record-thread/partner/model'
import { PartnerColumn, type PartnerColumnActions } from '../../../lib/record-thread/partner/view/PartnerColumn'
import type { PartnerWidth } from '../../../lib/record-thread/partner/view/PartnerHead'

/**
 * Messages (design portal.frame › thread; COL-059, COL-060): ONE conversation per record, shared with us — our messages and theirs,
 * never an internal note. pt-w2 W2.3 (lane pt-, A1): the portal's thin ADAPTER onto the ONE partner face (lib/record-thread/partner) —
 * the office's row, list, composer row and pinned bar. Its model keeps its shape (the design fixtures fit as they are); what the live
 * host adds is optional.
 */
export interface ThreadViewModel {
  state: 'loading' | 'error' | 'ready'
  title?: string
  /** The record: their reference first, ours second (names the column). Null: the account. */
  record: { theirs: string | null; ours: string | null } | null
  companyName: string
  /** Oldest first. */
  messages: readonly PortalThreadMessage[]
  composer: { value: string; busy: boolean; heldReason: string | null; hint: string | null; limit: number } | null
  /** Older messages exist (read as the person scrolls up); busy: one is read. */
  loadMore: { busy: boolean } | null
  /** Who can do what this person cannot ("…ask your admin (Ugo Test)"): the ONE held line; null: nothing to say. */
  accessLine: string | null
  /** The last act failed, in words (the typed text stays). */
  failed: string | null
  /** B-TH-286: the pins of messages shared with this customer (never who pinned). */
  pins?: readonly { readonly id: string; readonly author: string | null; readonly words: string; readonly date: string; readonly pinnedAt?: string; readonly files?: number; readonly removed?: boolean }[]
  /** F-CP-156: "Ask <name>, factory designer" — ticked, an "@" being typed (the chip completes it), why it cannot be ticked now. */
  designer?: { readonly name: string; readonly ask: boolean; readonly chip: boolean; readonly held: string | null } | null
  // ---- pt-w2 W2.3: the live host's (every one optional)
  kind?: PartnerKind
  older?: 'idle' | 'loading' | 'failed'
  reading?: { readonly firstNewId: string | null; readonly newCount: number } | null
  flash?: { readonly id: string; readonly seq: number } | null
  replyTo?: string | null
  /** What the last post said ("We asked Dora Campione."), in the ONE bar. */
  said?: string | null
  /** More sentences for the ⓘ (the supplier's price talk). */
  help?: readonly string[]
  width?: PartnerWidth | null
}

export interface ThreadViewProps extends Omit<PartnerColumnActions, 'onOlder' | 'onAskDesigner' | 'onDesignerChip'> {
  model: ThreadViewModel
  onMore?: () => void
  onAskDesigner?: (ask: boolean) => void
  onDesignerChip?: () => void
}

export function ThreadView({ model, onMore, ...actions }: ThreadViewProps): ReactNode {
  const t = useT('portal')
  const title = model.title ?? t('thread.title')
  const designer = model.designer ?? null
  const hint = designer ? `${t('thread.designer.hint', { name: designer.name })} ${t('thread.designer.typeAt', { name: designer.name })}` : null
  return (
    <PartnerColumn
      model={{
        kind: model.kind ?? 'record',
        state: model.state,
        title,
        recordName: model.record?.theirs ?? model.record?.ours ?? title,
        companyName: model.companyName,
        messages: model.messages,
        more: model.loadMore !== null,
        older: model.loadMore?.busy ? 'loading' : (model.older ?? 'idle'),
        reading: model.reading ?? null,
        flash: model.flash ?? null,
        pins: (model.pins ?? []).map((pin) => ({ messageId: pin.id, pinnedAt: pin.pinnedAt ?? pin.date, authorName: pin.author, excerpt: pin.words, files: pin.files ?? 0, removed: pin.removed ?? false })),
        composer: model.composer
          ? {
              value: model.composer.value,
              busy: model.composer.busy,
              held: model.accessLine ?? model.composer.heldReason,
              said: model.said ?? null,
              designer: designer && hint ? { ask: t('thread.designer.ask', { name: designer.name }), on: designer.ask, hint, held: designer.held, completes: designer.chip } : null,
            }
          : null,
        replyTo: model.replyTo ?? null,
        help: [...(model.composer?.hint ? [model.composer.hint] : []), ...(hint ? [hint] : []), ...(model.help ?? [])],
        notice: model.failed,
        width: model.width ?? null,
      }}
      actions={{ ...actions, onOlder: onMore }}
    />
  )
}
