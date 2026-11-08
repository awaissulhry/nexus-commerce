'use client'

import type { Locale } from '../../../../lib/i18n/locales'
import { useLocale } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import { PortalShellView, type PortalShellViewModel } from '../../../shell/view/PortalShellView'
import { AccountClosedView, type AccountClosedModel } from './AccountClosedView'
import { AccountView, type AccountViewModel } from './AccountView'

/**
 * SCR-188 as one case of the design review (B-W2b-196): the portal frame (SCR-027's view) around the Account page, with the
 * band the page fills. The live page composes the same views (AccountRoute → AccountPage); this only puts a case's made-up
 * models together, built in the page's language.
 */

export interface AccountCaseModel {
  shell: PortalShellViewModel
  page: { kind: 'account'; model: AccountViewModel } | { kind: 'closed'; model: AccountClosedModel }
}

export type AccountCaseBuilder = (locale: Locale) => AccountCaseModel

export function AccountCase({ model: build }: { model: AccountCaseBuilder }) {
  const model = build(useLocale())
  return (
    <PortalShellView model={model.shell}>
      <WithMessages namespaces={['portal', 'portal-account', 'lists']}>{model.page.kind === 'account' ? <AccountView model={model.page.model} /> : <AccountClosedView model={model.page.model} />}</WithMessages>
    </PortalShellView>
  )
}
