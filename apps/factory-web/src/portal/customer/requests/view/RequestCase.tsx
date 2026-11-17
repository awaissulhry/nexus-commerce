'use client'

import type { Locale } from '../../../../lib/i18n/locales'
import { useLocale } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import { PortalShellView, type PortalShellViewModel } from '../../../shell/view/PortalShellView'
import { ThreadView, type ThreadViewModel } from '../../../shell/view/ThreadView'
import { NS } from '../model'
import { RequestRecordView, type RequestRecordModel } from './RequestView'

/**
 * SCR-185-request as one case of the design review (B-TH-222): the portal frame around the customer's request page, its band
 * filled as the live page fills it, the thread drawn by the portal's ThreadView (the DS PartnerThread) with made-up messages.
 * The live page composes the same views.
 */
export interface RequestCaseModel {
  shell: PortalShellViewModel
  page: RequestRecordModel
  thread: ThreadViewModel | null
}

export type RequestCaseBuilder = (locale: Locale) => RequestCaseModel

export function RequestCase({ model: build }: { model: RequestCaseBuilder }) {
  const locale = useLocale()
  const model = build(locale)
  return (
    <WithMessages namespaces={[NS, 'portal-orders', 'ds-words', 'portal', 'shell', 'request-compose']}>
      <PortalShellView model={model.shell}>
        <RequestRecordView model={model.page} thread={model.thread ? <ThreadView model={model.thread} /> : null} />
      </PortalShellView>
    </WithMessages>
  )
}
