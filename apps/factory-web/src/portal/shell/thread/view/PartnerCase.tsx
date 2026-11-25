'use client'

import { useState, type ReactNode } from 'react'
import type { Locale } from '../../../../lib/i18n/locales'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import type { PortalPin, PortalThreadMessage } from '../../../../lib/record-thread/partner/model'
import { PartnerColumn } from '../../../../lib/record-thread/partner/view/PartnerColumn'
import { withDesignerMention } from '../../thread-model'
import { ThreadView, type ThreadViewModel } from '../../view/ThreadView'
import '../thread.css'

/** A made-up message of a case, its words in both languages. */
export type PartnerCaseMessage = Omit<PortalThreadMessage, 'body'> & { readonly body: Readonly<Record<Locale, string>> }

/** Where a case stands: the dock at a third (433 px at 1440), 40 % (450), half (562), 40 % at 1920 (642), a main column (~865), the phone (375). */
export type PartnerCaseFrame = 'third' | 'forty' | 'half' | 'wide' | 'main' | 'phone'

export interface PartnerCaseModel {
  readonly frame: PartnerCaseFrame
  readonly kind?: 'record' | 'account' | 'link'
  readonly state?: 'loading' | 'error' | 'ready'
  readonly messages: readonly PartnerCaseMessage[]
  readonly reading?: { readonly firstNewId: string | null; readonly newCount: number } | null
  /** The row a jump lit (the case starts lit). */
  readonly flash?: string | null
  readonly pins?: readonly PortalPin[]
  /** Writing held: why (the host's ONE line). */
  readonly held?: 'PREVIEW' | 'NO_COMMENT' | 'CLOSED' | null
  /** The admins the NO_COMMENT line names. */
  readonly admins?: readonly string[]
  /** "Ask <name>, factory designer": ticked, held (why), an "@" being typed. */
  readonly designer?: { readonly name: string; readonly on: boolean; readonly held?: boolean; readonly completes?: boolean } | null
  /** What the last post said in the box's bar. */
  readonly said?: 'asked' | 'capped' | null
  readonly replyTo?: string | null
  readonly draft?: string
  /** The last act failed: a refused reply, writing closed meanwhile. */
  readonly failed?: 'reply' | 'conflict' | null
  /** The frame's width chooser (its ⋮). */
  readonly widthMenu?: boolean
  readonly more?: boolean
  /** The link kind's shared files and the ones ticked. */
  readonly attach?: { readonly files: readonly { readonly id: string; readonly name: string }[]; readonly attached: readonly string[] } | null
  /** The supplier's price talk in the ⓘ. */
  readonly priceTalk?: boolean
}

const COMPANY = 'Example Works'

/**
 * SCR-027-thread (pt-t T.1, lane pt-): the portal's messages — the ONE partner face on the office's thread parts — as every portal page and
 * the invite page draw it, in made-up cases: docked at a third, 40 %, half, 40 % at 1920, a main column, the phone. The box works here
 * (type, Reply, × , the designer chip, a quote's jump lights its row): nothing leaves the browser.
 */
export function PartnerCase({ model }: { model: PartnerCaseModel }): ReactNode {
  const t = useT('portal')
  const supplier = useT('portal-supplier-orders') // the supplier order's price talk, in its ⓘ (A19)
  const locale = useLocale()
  const [draft, setDraft] = useState(model.draft ?? '')
  const [replyTo, setReplyTo] = useState<string | null>(model.replyTo ?? null)
  const [ask, setAsk] = useState(model.designer?.on ?? false)
  const [flash, setFlash] = useState<{ id: string; seq: number } | null>(model.flash ? { id: model.flash, seq: 1 } : null)
  const [attached, setAttached] = useState<readonly string[]>(model.attach?.attached ?? [])
  const messages: PortalThreadMessage[] = model.messages.map((message) => ({ ...message, body: message.body[locale] }))
  const jump = (id: string) => setFlash((was) => ({ id, seq: (was?.seq ?? 0) + 1 }))
  const held = model.held ? t(`thread.held.${model.held}`) : null
  const access = model.held === 'NO_COMMENT' ? (model.admins && model.admins.length > 0 ? t('thread.whoCan', { names: model.admins.join(', ') }) : t('thread.whoCanNoAdmin')) : null
  const designer = model.designer ?? null
  const failed = model.failed === 'reply' ? t('thread.reply.refused') : model.failed === 'conflict' ? t('thread.failed.conflict') : null
  const said = model.said === 'asked' && designer ? t('thread.designer.asked', { name: designer.name }) : model.said === 'capped' ? t('thread.designer.capped') : null
  const width = model.widthMenu ? { widths: ['third', 'forty', 'half'], current: 'forty', choose: () => undefined } : null

  if (model.kind === 'link') {
    return (
      <div className={`fw-ptc is-${model.frame}`}>
        <PartnerColumn
          model={{
            kind: 'link',
            state: model.state ?? 'ready',
            title: t('thread.title'),
            recordName: 'Your order 142',
            companyName: COMPANY,
            messages,
            more: model.more === true,
            composer: { value: draft, busy: false, held, attach: model.attach ? { files: model.attach.files, attached } : null },
            help: [t('thread.hint')],
            notice: failed,
          }}
          actions={{ onChange: setDraft, onAttach: setAttached, onSend: () => setDraft('') }}
        />
      </div>
    )
  }

  const view: ThreadViewModel = {
    kind: model.kind ?? 'record',
    state: model.state ?? 'ready',
    title: model.kind === 'account' ? t('thread.accountTitle') : t('thread.title'),
    record: model.kind === 'account' ? null : { theirs: 'Your order 142', ours: 'SO-2026-0142' },
    companyName: COMPANY,
    messages,
    composer: { value: draft, busy: false, heldReason: held, hint: t('thread.hint'), limit: 20_000 },
    loadMore: model.more ? { busy: false } : null,
    accessLine: access,
    failed,
    pins: (model.pins ?? []).map((pin) => ({ id: pin.messageId, author: pin.authorName, words: pin.excerpt, date: pin.pinnedAt, pinnedAt: pin.pinnedAt, files: pin.files, removed: pin.removed })),
    designer: designer && !held ? { name: designer.name, ask, chip: designer.completes === true, held: designer.held ? t('thread.designer.notHere') : null } : null,
    reading: model.reading ?? null,
    flash,
    replyTo,
    said,
    ...(model.priceTalk ? { help: [supplier('messages.priceTalk')] } : {}),
    width,
  }
  return (
    <div className={`fw-ptc is-${model.frame}`}>
      <ThreadView
        model={view}
        onChange={setDraft}
        onSend={() => {
          setDraft('')
          setReplyTo(null)
        }}
        onReply={setReplyTo}
        onDropReply={() => setReplyTo(null)}
        onJump={jump}
        onAskDesigner={setAsk}
        onDesignerChip={() => {
          if (!designer) return
          setDraft((now) => withDesignerMention(now, designer.name))
          setAsk(true)
        }}
      />
    </div>
  )
}
