'use client'

import type { Locale } from '../../../../lib/i18n/locales'
import { useLocale } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import { PortalShellView, type PortalShellViewModel } from '../../../shell/view/PortalShellView'
import { TasksView, type TasksViewModel } from '../../../shell/view/TasksView'
import { ThreadView, type ThreadViewModel } from '../../../shell/view/ThreadView'
import { SupplierHomeView, type SupplierHomeViewModel } from '../../home/view/SupplierHomeView'
import { NS } from '../model'
import { useOrderWords } from '../words'
import { NotInAccess } from '../parts'
import { OrderRecordView, PriceTalkHint, type OrderRecordViewModel } from './OrderRecordView'
// ---- B-TH-277: the PO's conversation docked beside the tabs (the portal record frame), as the live page draws it.
import { PortalRecordFrame } from '../../../shell/record/PortalRecordFrame'
import type { PortalFrameMode } from '../../../shell/record/model'
// ---- end B-TH-277
import { OrdersListView, type OrdersListViewModel } from './OrdersListView'

/**
 * SCR-189 as one case of the design review (B-W2b-179): the portal frame (B-W2b-173's PortalShellView, its band filled as
 * the live page fills it) around the supplier's Home, the Purchase orders list or one order, with made-up data. The live
 * pages compose the same views.
 */

export type SupplierCaseBody =
  | { kind: 'home'; model: SupplierHomeViewModel; tasks: TasksViewModel; confirmVerb?: string | null }
  | { kind: 'list'; model: OrdersListViewModel }
  // B-TH-277: `frame` — absent, the review frame's own width decides (docked from 1280 px, the "Messages" button below); given, the
  // narrow page whatever the width (its "Messages (2 new)" button, or the conversation open).
  | { kind: 'record'; model: OrderRecordViewModel; thread: ThreadViewModel | null; frame?: { mode: PortalFrameMode; viewOpen?: boolean; newCount?: number } }
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
          <RecordBody body={body} />
        ) : (
          <NotInAccess admins={body.admins} homeHref={model.shell.prefix} />
        )}
      </PortalShellView>
    </WithMessages>
  )
}

/** B-TH-277: one order in the portal record frame — its tab, and the PO's conversation docked beside it (price talk lives there). */
function RecordBody({ body }: { body: Extract<SupplierCaseBody, { kind: 'record' }> }) {
  const { t } = useOrderWords()
  return (
    <PortalRecordFrame
      thread={
        body.thread ? (
          <>
            <PriceTalkHint />
            <ThreadView model={body.thread} />
          </>
        ) : null
      }
      threadLabel={t('thread.label', { number: body.model.page?.order.documentNumber ?? '' })}
      design={body.frame}
    >
      <OrderRecordView model={body.model} />
    </PortalRecordFrame>
  )
}
