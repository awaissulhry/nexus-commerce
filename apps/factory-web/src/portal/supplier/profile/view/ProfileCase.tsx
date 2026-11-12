'use client'

import type { Locale } from '../../../../lib/i18n/locales'
import { useLocale } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import { PortalShellView, type PortalShellViewModel } from '../../../shell/view/PortalShellView'
import { NotInAccess } from '../../orders/parts'
import { NS as ORDERS_NS } from '../../orders/model'
import { NS } from '../model'
import { ProfileView, type ProfileViewModel } from './ProfileView'
// B-W2b-334: Profile › Bank details.
import { BankSection, type BankSectionModel } from '../bank/view/BankSection'

/**
 * SCR-191 as one case of the design review (B-W2b-193): the portal frame (B-W2b-173's PortalShellView, its band filled as
 * the live page fills it) around the supplier's Profile, or the "not part of your access" panel, with made-up data. The
 * live page composes the same views (SupplierProfileRoute → ProfileView).
 */

export interface ProfileCaseModel {
  shell: PortalShellViewModel
  body: { kind: 'page'; model: ProfileViewModel; bank?: BankSectionModel } | { kind: 'noAccess'; admins: readonly string[] }
}

/** A case is drawn in the page's language: its made-up words come in both. */
export type ProfileCaseBuilder = (locale: Locale) => ProfileCaseModel

export function ProfileCase({ model: build }: { model: ProfileCaseBuilder }) {
  const model = build(useLocale())
  return (
    <WithMessages namespaces={[NS, ORDERS_NS, 'portal', 'portal-account', 'shell', 'lists', 'ds-words', 'purchasing-suppliers-depth']}>
      <PortalShellView model={model.shell}>{model.body.kind === 'page' ? <ProfileView model={model.body.model} bank={model.body.bank ? <BankSection model={model.body.bank} /> : null} /> : <NotInAccess admins={model.body.admins} homeHref={model.shell.prefix} />}</PortalShellView>
    </WithMessages>
  )
}
