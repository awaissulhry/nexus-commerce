'use client'

import type { Locale } from '../../../../lib/i18n/locales'
import { useLocale } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import { PortalShellView, type PortalShellViewModel } from '../../../shell/view/PortalShellView'
import { TasksView, type TasksViewModel } from '../../../shell/view/TasksView'
import { ThreadView, type ThreadViewModel } from '../../../shell/view/ThreadView'
import { SupplierHomeView, type SupplierHomeViewModel } from '../../home/view/SupplierHomeView'
import { NS } from '../model'
import { NotInAccess } from '../parts'
import { OrderRecordView, type OrderRecordViewModel } from './OrderRecordView'
import { OrdersListView, type OrdersListViewModel } from './OrdersListView'

/**
 * SCR-189 as one case of the design review (B-W2b-179): the portal frame (B-W2b-173's PortalShellView, its band filled as
 * the live page fills it) around the supplier's Home, the Purchase orders list or one order, with made-up data. The live
 * pages compose the same views.
 */

export type SupplierCaseBody =
  | { kind: 'home'; model: SupplierHomeViewModel; tasks: TasksViewModel; confirmVerb?: string | null }
  | { kind: 'list'; model: OrdersListViewModel }
  | { kind: 'record'; model: OrderRecordViewModel; thread: ThreadViewModel | null }
  | { kind: 'noAccess'; admins: readonly string[] }

export interface SupplierCaseModel {
  shell: PortalShellViewModel
  body: SupplierCaseBody
}

/** A case is drawn in the page's language: its made-up words come in both. */
export type SupplierCaseBuilder = (locale: Locale) => SupplierCaseModel

export function SupplierCase({ model: build }: { model: SupplierCaseBuilder }) {
  const locale = useLocale()
  const model = build(locale)
  const body = model.body
  return (
    <WithMessages namespaces={[NS, 'ds-words', 'portal', 'shell']}>
      <PortalShellView model={model.shell}>
        {body.kind === 'home' ? (
          <SupplierHomeView
            model={body.model}
            tasks={<TasksView model={body.tasks} verbFor={(row) => (body.confirmVerb && row.kind === 'CONFIRM_PO' ? { label: body.confirmVerb, onRun: () => undefined, heldReason: row.held ?? null } : null)} />}
          />
        ) : body.kind === 'list' ? (
          <OrdersListView model={body.model} />
        ) : body.kind === 'record' ? (
          <OrderRecordView model={body.model}>{body.thread ? <ThreadView model={body.thread} /> : null}</OrderRecordView>
        ) : (
          <NotInAccess admins={body.admins} homeHref={model.shell.prefix} />
        )}
      </PortalShellView>
    </WithMessages>
  )
}
