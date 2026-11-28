'use client'

import type { Locale } from '../../../../lib/i18n/locales'
import { useLocale } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import { PortalShellView, type PortalShellViewModel } from '../../../shell/view/PortalShellView'
import { AccountClosedView, type AccountClosedModel } from '../../account/view/AccountClosedView'
import { PeopleView, type PeopleViewModel } from './PeopleView'

/**
 * SCR-188-people as one case of the design review (owb-po4.3): the portal frame (SCR-027's view) around Your people, with the band
 * the page fills. The live page composes the same views (PeopleRoute → PeoplePage); this only puts a case's made-up models together.
 */

export interface PeopleCaseModel {
  shell: PortalShellViewModel
  page: { kind: 'people'; model: PeopleViewModel } | { kind: 'closed'; model: AccountClosedModel }
}

export type PeopleCaseBuilder = (locale: Locale) => PeopleCaseModel

export function PeopleCase({ model: build }: { model: PeopleCaseBuilder }) {
  const model = build(useLocale())
  return (
    <PortalShellView model={model.shell}>
      <WithMessages namespaces={['portal', 'portal-account', 'lists']}>{model.page.kind === 'people' ? <PeopleView model={model.page.model} /> : <AccountClosedView model={model.page.model} />}</WithMessages>
    </PortalShellView>
  )
}
