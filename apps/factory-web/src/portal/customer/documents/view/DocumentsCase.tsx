'use client'

import type { Locale } from '../../../../lib/i18n/locales'
import { useLocale } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import { PortalShellView, type PortalShellViewModel } from '../../../shell/view/PortalShellView'
import { NS } from '../model'
import { DocumentsClosedView, DocumentsView, type DocumentsViewModel } from './DocumentsView'

/**
 * SCR-186 as one case of the design review (B-W2b-195): the portal frame (B-W2b-173's PortalShellView, its band filled as
 * the live page fills it) around the customer's Documents — or the page a role does not open — with made-up data. The live
 * page (DocumentsPage) composes the same views.
 */

export interface DocumentsCaseModel {
  shell: PortalShellViewModel
  page: { kind: 'page'; model: DocumentsViewModel } | { kind: 'closed'; admins: readonly string[] }
}

/** A case is drawn in the page's language: its made-up words come in both. */
export type DocumentsCaseBuilder = (locale: Locale) => DocumentsCaseModel

export function DocumentsCase({ model: build }: { model: DocumentsCaseBuilder }) {
  const model = build(useLocale())
  return (
    <WithMessages namespaces={[NS, 'portal', 'shell', 'ds-words', 'lists']}>
      <PortalShellView model={model.shell}>
        {model.page.kind === 'page' ? <DocumentsView model={model.page.model} /> : <DocumentsClosedView model={{ admins: model.page.admins, homeHref: model.shell.prefix }} />}
      </PortalShellView>
    </WithMessages>
  )
}
