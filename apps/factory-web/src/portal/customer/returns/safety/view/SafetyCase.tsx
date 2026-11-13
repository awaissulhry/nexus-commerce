'use client'

import type { Locale } from '../../../../../lib/i18n/locales'
import { useLocale } from '../../../../../lib/i18n/provider'
import { ReportDialog, type ReportDialogViewModel } from '../../../../../lib/safety-reports/view/ReportDialog'
import { WithMessages } from '../../../../../record-panels/i18n'
import { PortalShellView, type PortalShellViewModel } from '../../../../shell/view/PortalShellView'
import { NS } from '../../model'
import { ReturnsListView, type ReturnsListViewModel } from '../../view/ReturnsListView'

/**
 * SCR-187-safety as one case of the design review (B-W2b-357): the portal frame around the customer's Returns & claims (the
 * band's ⋯ with Report a safety incident, the start's card), and the safety report's dialog over it when the case opens one.
 * Made-up data; the live page composes the same views.
 */
export interface SafetyCaseModel {
  readonly shell: PortalShellViewModel
  readonly list: ReturnsListViewModel
  readonly dialog: ReportDialogViewModel | null
}

export type SafetyCaseBuilder = (locale: Locale) => SafetyCaseModel

export function SafetyCase({ model: build }: { model: SafetyCaseBuilder }) {
  const model = build(useLocale())
  return (
    <WithMessages namespaces={[NS, 'returns-repair', 'ds-words', 'portal', 'shell', 'lists', 'returns-remake', 'safety-reports']}>
      <PortalShellView model={model.shell}>
        <ReturnsListView model={model.list} />
      </PortalShellView>
      {model.dialog && <ReportDialog model={model.dialog} />}
    </WithMessages>
  )
}
