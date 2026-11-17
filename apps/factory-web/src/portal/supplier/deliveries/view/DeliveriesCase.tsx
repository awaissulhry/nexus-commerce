'use client'

import type { Locale } from '../../../../lib/i18n/locales'
import { useLocale } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import { PortalShellView, type PortalShellViewModel } from '../../../shell/view/PortalShellView'
import { NotInAccess } from '../../orders/parts'
import { NS as ORDERS_NS } from '../../orders/model'
import { NS } from '../model'
import { useDeliveryWords } from '../words'
// ---- B-TH-277: the order's conversation docked beside the notice and its steps (the portal record frame), as the live page draws it.
import { ThreadView, type ThreadViewModel } from '../../../shell/view/ThreadView'
import { PortalRecordFrame } from '../../../shell/record/PortalRecordFrame'
import type { PortalFrameMode } from '../../../shell/record/model'
import type { ReactNode } from 'react'
// ---- end B-TH-277
import { AnnounceView, type AnnounceViewModel } from './AnnounceView'
import { DeliveriesListView, type DeliveriesListViewModel } from './DeliveriesListView'
import { CancelDialog, type CancelModel } from './Dialogs'
import { NoticeView, type NoticeViewModel } from './NoticeView'

/**
 * SCR-227 as one case of the design review (B-W2b-186): the portal frame (B-W2b-173's PortalShellView, its band filled as the
 * live page fills it) around the Ship notices list, the steps of announcing a delivery, or one notice, with made-up data. The
 * live pages compose the same views.
 */

/**
 * B-TH-277: the order's conversation (null: no order yet — no dock) and its frame — absent, the review frame's own width decides
 * (docked from 1280 px, the "Messages" button below); given, the narrow page whatever the width.
 */
export interface DeliveriesCaseThread {
  thread?: { model: ThreadViewModel; number: string } | null
  frame?: { mode: PortalFrameMode; viewOpen?: boolean; newCount?: number }
}

export type DeliveriesCaseBody =
  | { kind: 'list'; model: DeliveriesListViewModel }
  | ({ kind: 'announce'; model: AnnounceViewModel; dialog?: CancelModel | null } & DeliveriesCaseThread)
  | ({ kind: 'notice'; model: NoticeViewModel } & DeliveriesCaseThread)
  | { kind: 'noAccess'; admins: readonly string[] }

export interface DeliveriesCaseModel {
  shell: PortalShellViewModel
  body: DeliveriesCaseBody
}

/** A case is drawn in the page's language: its made-up words come in both. */
export type DeliveriesCaseBuilder = (locale: Locale) => DeliveriesCaseModel

export function DeliveriesCase({ model: build }: { model: DeliveriesCaseBuilder }) {
  const locale = useLocale()
  const model = build(locale)
  const body = model.body
  return (
    <WithMessages namespaces={[NS, ORDERS_NS, 'ds-words', 'portal', 'shell', 'lists']}>
      <PortalShellView model={model.shell}>
        {body.kind === 'list' ? (
          <DeliveriesListView model={body.model} />
        ) : body.kind === 'announce' ? (
          <Docked body={body}>
            <AnnounceView model={body.model} />
            {body.dialog ? <CancelDialog model={body.dialog} /> : null}
          </Docked>
        ) : body.kind === 'notice' ? (
          <Docked body={body}>
            <NoticeView model={body.model} />
          </Docked>
        ) : (
          <NotInAccess admins={body.admins} homeHref={model.shell.prefix} />
        )}
      </PortalShellView>
    </WithMessages>
  )
}

/** B-TH-277: the notice (or its steps) in the portal record frame, the order's conversation docked beside it. */
function Docked({ body, children }: { body: DeliveriesCaseThread; children: ReactNode }) {
  const { t } = useDeliveryWords()
  return (
    <PortalRecordFrame thread={body.thread ? <ThreadView model={body.thread.model} /> : null} threadLabel={t('thread.label', { number: body.thread?.number ?? '' })} design={body.frame}>
      {children}
    </PortalRecordFrame>
  )
}
