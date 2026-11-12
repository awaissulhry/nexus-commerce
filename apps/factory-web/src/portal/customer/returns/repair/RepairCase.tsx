'use client'

import type { Locale } from '../../../../lib/i18n/locales'
import { useLocale } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import { PortalShellView, type PortalShellViewModel } from '../../../shell/view/PortalShellView'
import { NS as RETURNS_NS } from '../model'
import { NotInAccess } from '../view/parts'
import { NS } from './model'
import { RepairRecordView, type RepairRecordViewModel } from './RepairRecordView'

/**
 * SCR-358 as one case of the design review (B-W2b-342): the portal frame (B-W2b-173's PortalShellView, its band filled as
 * the live page fills it) around one repair, with made-up data. The live page composes the same view.
 */
export type RepairCaseModel = { shell: PortalShellViewModel; body: { kind: 'record'; model: RepairRecordViewModel } | { kind: 'noAccess'; admins: readonly string[] } }
export type RepairCaseBuilder = (locale: Locale) => RepairCaseModel

export function RepairCase({ model: build }: { model: RepairCaseBuilder }) {
  const locale = useLocale()
  const model = build(locale)
  return (
    <WithMessages namespaces={[NS, RETURNS_NS, 'ds-words', 'portal', 'shell', 'lists']}>
      <PortalShellView model={model.shell}>{model.body.kind === 'record' ? <RepairRecordView model={model.body.model} /> : <NotInAccess admins={model.body.admins} homeHref={model.shell.prefix} />}</PortalShellView>
    </WithMessages>
  )
}
