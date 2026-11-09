'use client'

import type { Locale } from '../../../../lib/i18n/locales'
import { useLocale } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import { PortalShellView, type PortalShellViewModel } from '../../../shell/view/PortalShellView'
import { CatalogueView, type CatalogueViewModel } from '../../catalogue/view/CatalogueView'
import { StyleSheetView, type StyleSheetModel } from '../../catalogue/view/StyleSheetView'
import { NS } from '../model'
import { NewOrderView, type NewOrderViewModel } from './NewOrderView'
import { NotInAccess } from './parts'

/**
 * SCR-185 and SCR-226 as one case of the design review (B-W2b-194): the portal frame (B-W2b-173's PortalShellView, its band
 * filled as the live page fills it) around New order & reorder, the Catalogue or the style sheet tab, with made-up data. The
 * live pages compose the same views.
 */
export type OrderingCaseBody =
  | { kind: 'neworder'; model: NewOrderViewModel }
  | { kind: 'catalogue'; model: CatalogueViewModel }
  | { kind: 'sheet'; model: StyleSheetModel }
  | { kind: 'noAccess'; admins: readonly string[] }

export interface OrderingCaseModel {
  shell: PortalShellViewModel
  body: OrderingCaseBody
}

/** A case is drawn in the page's language: its made-up words come in both. */
export type OrderingCaseBuilder = (locale: Locale) => OrderingCaseModel

export function OrderingCase({ model: build }: { model: OrderingCaseBuilder }) {
  const locale = useLocale()
  const model = build(locale)
  const body = model.body
  return (
    <WithMessages namespaces={[NS, 'ds-words', 'portal', 'shell', 'lists', 'portal-account']}>
      <PortalShellView model={model.shell}>
        {body.kind === 'neworder' ? (
          <NewOrderView model={body.model} />
        ) : body.kind === 'catalogue' ? (
          <CatalogueView model={body.model} />
        ) : body.kind === 'sheet' ? (
          <StyleSheetView model={body.model} />
        ) : (
          <NotInAccess admins={body.admins} homeHref={model.shell.prefix} />
        )}
      </PortalShellView>
    </WithMessages>
  )
}
