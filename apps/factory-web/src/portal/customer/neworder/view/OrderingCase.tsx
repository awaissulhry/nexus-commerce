'use client'

import type { Locale } from '../../../../lib/i18n/locales'
import { useLocale } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import { PortalShellView, type PortalShellViewModel } from '../../../shell/view/PortalShellView'
import { CatalogueView, type CatalogueViewModel } from '../../catalogue/view/CatalogueView'
import { StyleSheetView, type StyleSheetModel } from '../../catalogue/view/StyleSheetView'
import { COMPOSE_NS } from '../../../../lib/request-compose/model'
import { NS } from '../model'
import { useOrderingWords } from '../words'
import { NewOrderView, type NewOrderViewModel } from './NewOrderView'
import { NotInAccess } from './parts'
import { RequestPageView, type RequestPageModel } from './RequestPageView'

/**
 * SCR-185 and SCR-226 as one case of the design review (B-W2b-194): the portal frame (B-W2b-173's PortalShellView, its band
 * filled as the live page fills it) around New order as an e-mail (B-TH-220), the catalogue door's New order & reorder, the
 * Catalogue or the style sheet tab, with made-up data. The live pages compose the same views.
 */
export type OrderingCaseBody =
  // B-TH-220: New order as an e-mail.
  | { kind: 'request'; model: RequestPageModel }
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
    <WithMessages namespaces={[NS, COMPOSE_NS, 'ds-words', 'portal', 'shell', 'lists', 'portal-account']}>
      <PortalShellView model={model.shell}>
        {body.kind === 'request' ? (
          <RequestCaseBody model={body.model} />
        ) : body.kind === 'neworder' ? (
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

/** B-TH-220: the page view with the page's own day writer. */
function RequestCaseBody({ model }: { model: RequestPageModel }) {
  const { day } = useOrderingWords()
  return <RequestPageView model={model} day={day} />
}
