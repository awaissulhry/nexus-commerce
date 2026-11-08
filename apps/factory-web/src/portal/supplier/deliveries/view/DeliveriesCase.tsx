'use client'

import type { Locale } from '../../../../lib/i18n/locales'
import { useLocale } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import { PortalShellView, type PortalShellViewModel } from '../../../shell/view/PortalShellView'
import { NotInAccess } from '../../orders/parts'
import { NS as ORDERS_NS } from '../../orders/model'
import { NS } from '../model'
import { AnnounceView, type AnnounceViewModel } from './AnnounceView'
import { DeliveriesListView, type DeliveriesListViewModel } from './DeliveriesListView'
import { CancelDialog, type CancelModel } from './Dialogs'
import { NoticeView, type NoticeViewModel } from './NoticeView'

/**
 * SCR-227 as one case of the design review (B-W2b-186): the portal frame (B-W2b-173's PortalShellView, its band filled as the
 * live page fills it) around the Ship notices list, the steps of announcing a delivery, or one notice, with made-up data. The
 * live pages compose the same views.
 */

export type DeliveriesCaseBody =
  | { kind: 'list'; model: DeliveriesListViewModel }
  | { kind: 'announce'; model: AnnounceViewModel; dialog?: CancelModel | null }
  | { kind: 'notice'; model: NoticeViewModel }
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
          <>
            <AnnounceView model={body.model} />
            {body.dialog ? <CancelDialog model={body.dialog} /> : null}
          </>
        ) : body.kind === 'notice' ? (
          <NoticeView model={body.model} />
        ) : (
          <NotInAccess admins={body.admins} homeHref={model.shell.prefix} />
        )}
      </PortalShellView>
    </WithMessages>
  )
}
