'use client'

import type { Locale } from '../../../../lib/i18n/locales'
import { useLocale } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import { PortalShellView, type PortalShellViewModel } from '../../../shell/view/PortalShellView'
import { ThreadView, type ThreadViewModel } from '../../../shell/view/ThreadView'
import { NS } from '../model'
import { ProjectPageView, type ProjectPageModel } from './ProjectPageView'

/**
 * SCR-702 as one case of the design review (B-TH-253): the portal frame around a project's page, its band filled as the live page
 * fills it, the conversation drawn by the portal's ThreadView (the DS PartnerThread) with made-up messages. The live page composes
 * the same views.
 */
export interface ProjectCaseModel {
  shell: PortalShellViewModel
  page: ProjectPageModel
  thread: ThreadViewModel | null
}

export type ProjectCaseBuilder = (locale: Locale) => ProjectCaseModel

export function ProjectCase({ model: build }: { model: ProjectCaseBuilder }) {
  const locale = useLocale()
  const model = build(locale)
  return (
    <WithMessages namespaces={[NS, 'portal-orders', 'ds-words', 'portal', 'shell']}>
      <PortalShellView model={model.shell}>
        <ProjectPageView model={model.page} thread={model.thread ? <ThreadView model={model.thread} /> : null} />
      </PortalShellView>
    </WithMessages>
  )
}
