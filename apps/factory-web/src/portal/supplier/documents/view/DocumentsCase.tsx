'use client'

import type { Locale } from '../../../../lib/i18n/locales'
import { useLocale } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import { PortalShellView, type PortalShellViewModel } from '../../../shell/view/PortalShellView'
import { NotInAccess } from '../../orders/parts'
import { NS as ORDERS_NS } from '../../orders/model'
import { NS } from '../model'
import { DocumentsView, type DocumentsViewModel } from './DocumentsView'

/**
 * SCR-190 as one case of the design review (B-W2b-193): the portal frame (B-W2b-173's PortalShellView, its band filled as
 * the live page fills it) around the supplier's Documents, or the "not part of your access" panel, with made-up data. The
 * live page composes the same views (SupplierDocumentsRoute → DocumentsView).
 */

export interface DocumentsCaseModel {
  shell: PortalShellViewModel
  body: { kind: 'page'; model: DocumentsViewModel } | { kind: 'noAccess'; admins: readonly string[] }
}

/** A case is drawn in the page's language: its made-up words come in both. */
export type DocumentsCaseBuilder = (locale: Locale) => DocumentsCaseModel

export function DocumentsCase({ model: build }: { model: DocumentsCaseBuilder }) {
  const model = build(useLocale())
  return (
    <WithMessages namespaces={[NS, ORDERS_NS, 'portal', 'portal-account', 'shell', 'lists', 'ds-words']}>
      <PortalShellView model={model.shell}>{model.body.kind === 'page' ? <DocumentsView model={model.body.model} /> : <NotInAccess admins={model.body.admins} homeHref={model.shell.prefix} />}</PortalShellView>
    </WithMessages>
  )
}
