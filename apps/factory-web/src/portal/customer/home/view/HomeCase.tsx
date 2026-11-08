'use client'

import type { Locale } from '../../../../lib/i18n/locales'
import { useLocale } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import { PortalShellView, type PortalShellViewModel } from '../../../shell/view/PortalShellView'
import { TasksView, type TasksViewModel } from '../../../shell/view/TasksView'
import { approvalOfTask, NS } from '../model'
import { CustomerHomeView, type CustomerHomeViewModel } from './CustomerHomeView'

/**
 * SCR-183 as one case of the design review (B-W2b-187): the portal frame (B-W2b-173's PortalShellView, its band filled as
 * the live page fills it) around the customer's Home, with made-up data. The live page (CustomerHome) composes the same
 * views; Approve / Review on a row of What waits for you is the page's verb, as live.
 */

export interface HomeCaseModel {
  shell: PortalShellViewModel
  home: CustomerHomeViewModel
  tasks: TasksViewModel
  /** The verbs of the approval rows (Approve / Review), in the case's language. */
  verbs: Readonly<Record<string, string>>
}

/** A case is drawn in the page's language: its made-up words come in both. */
export type HomeCaseBuilder = (locale: Locale) => HomeCaseModel

export function HomeCase({ model: build }: { model: HomeCaseBuilder }) {
  const model = build(useLocale())
  return (
    <WithMessages namespaces={[NS, 'portal', 'shell', 'ds-words']}>
      <PortalShellView model={model.shell}>
        <CustomerHomeView
          model={model.home}
          tasks={<TasksView model={model.tasks} verbFor={(row) => (approvalOfTask(row) ? { label: model.verbs[row.kind] ?? row.verb, onRun: () => undefined, heldReason: row.held ?? null } : null)} />}
        />
      </PortalShellView>
    </WithMessages>
  )
}
