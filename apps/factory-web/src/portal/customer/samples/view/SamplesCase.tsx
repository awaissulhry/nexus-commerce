'use client'

import type { Locale } from '../../../../lib/i18n/locales'
import { useLocale } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import { PortalShellView, type PortalShellViewModel } from '../../../shell/view/PortalShellView'
import { NS } from '../model'
import { SamplesClosedView, SamplesView, type SamplesViewModel } from './SamplesView'

/**
 * SCR-225 as one case of the design review (B-W2b-262): the portal frame (B-W2b-173's PortalShellView, its band filled as
 * the live page fills it) around the brand's Samples & tech packs — or the page a role does not open — with made-up data.
 * The live page (SamplesPage) composes the same views.
 */

export interface SamplesCaseModel {
  shell: PortalShellViewModel
  page: { kind: 'page'; model: SamplesViewModel } | { kind: 'closed'; admins: readonly string[] }
}

/** A case is drawn in the page's language: its made-up words come in both. */
export type SamplesCaseBuilder = (locale: Locale) => SamplesCaseModel

export function SamplesCase({ model: build }: { model: SamplesCaseBuilder }) {
  const model = build(useLocale())
  return (
    <WithMessages namespaces={[NS, 'portal', 'shell', 'ds-words', 'lists']}>
      <PortalShellView model={model.shell}>
        {model.page.kind === 'page' ? <SamplesView model={model.page.model} /> : <SamplesClosedView model={{ admins: model.page.admins, homeHref: model.shell.prefix }} />}
      </PortalShellView>
    </WithMessages>
  )
}
