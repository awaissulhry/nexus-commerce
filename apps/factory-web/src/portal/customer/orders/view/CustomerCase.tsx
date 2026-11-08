'use client'

import type { Locale } from '../../../../lib/i18n/locales'
import { useLocale } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import { PortalShellView, type PortalShellViewModel } from '../../../shell/view/PortalShellView'
import { ThreadView, type ThreadViewModel } from '../../../shell/view/ThreadView'
import { NS } from '../model'
import { OrderRecordView, type OrderRecordViewModel } from './OrderRecordView'
import { OrdersListView, type OrdersListViewModel } from './OrdersListView'
import { OrdersPrintView, type OrdersPrintModel } from './OrdersPrintView'
import { NotInAccess } from './parts'

/**
 * SCR-184 as one case of the design review (B-W2b-191): the portal frame (B-W2b-173's PortalShellView, its band filled as the
 * live page fills it) around the customer's Orders & tracking list, its print view or one order, with made-up data. The live
 * pages compose the same views.
 */
export type CustomerCaseBody =
  | { kind: 'list'; model: OrdersListViewModel }
  | { kind: 'print'; model: OrdersPrintModel }
  | { kind: 'record'; model: OrderRecordViewModel; thread: ThreadViewModel | null }
  | { kind: 'noAccess'; admins: readonly string[] }

export interface CustomerCaseModel {
  shell: PortalShellViewModel
  body: CustomerCaseBody
}

/** A case is drawn in the page's language: its made-up words come in both. */
export type CustomerCaseBuilder = (locale: Locale) => CustomerCaseModel

export function CustomerCase({ model: build }: { model: CustomerCaseBuilder }) {
  const locale = useLocale()
  const model = build(locale)
  const body = model.body
  return (
    <WithMessages namespaces={[NS, 'ds-words', 'portal', 'shell', 'lists']}>
      <PortalShellView model={model.shell}>
        {body.kind === 'list' ? (
          <OrdersListView model={body.model} />
        ) : body.kind === 'print' ? (
          <OrdersPrintView model={body.model} />
        ) : body.kind === 'record' ? (
          <OrderRecordView model={body.model}>{body.thread ? <ThreadView model={body.thread} /> : null}</OrderRecordView>
        ) : (
          <NotInAccess admins={body.admins} homeHref={model.shell.prefix} />
        )}
      </PortalShellView>
    </WithMessages>
  )
}
