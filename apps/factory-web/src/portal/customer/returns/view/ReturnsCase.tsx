'use client'

import { useNarrow } from '@nexus/ui/components'
import type { Locale } from '../../../../lib/i18n/locales'
import { useLocale } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import { PortalShellView, type PortalShellViewModel } from '../../../shell/view/PortalShellView'
import { ThreadView, type ThreadViewModel } from '../../../shell/view/ThreadView'
import { NS } from '../model'
import { CaseRecordView, type CaseRecordViewModel } from './CaseRecordView'
import { NotInAccess } from './parts'
import { ReturnsListView, type ReturnsListViewModel } from './ReturnsListView'

/**
 * SCR-187 as one case of the design review (B-W2b-197): the portal frame (B-W2b-173's PortalShellView, its band filled as
 * the live page fills it) around the customer's Returns & claims list or one case, with made-up data. The live pages
 * compose the same views.
 */
export type ReturnsCaseBody =
  | { kind: 'list'; model: ReturnsListViewModel }
  | { kind: 'record'; model: CaseRecordViewModel; thread: ThreadViewModel | null }
  | { kind: 'noAccess'; admins: readonly string[] }

export interface ReturnsCaseModel {
  shell: PortalShellViewModel
  body: ReturnsCaseBody
}

/** A case is drawn in the page's language: its made-up words come in both. */
export type ReturnsCaseBuilder = (locale: Locale) => ReturnsCaseModel

export function ReturnsCase({ model: build }: { model: ReturnsCaseBuilder }) {
  const locale = useLocale()
  const narrow = useNarrow()
  const built = build(locale)
  // As the live page: on a phone the band holds the record's title only (band.ts refsOf).
  const model = narrow && built.shell.band?.refs ? { ...built, shell: { ...built.shell, band: { ...built.shell.band, refs: null } } } : built
  const body = model.body
  return (
    <WithMessages namespaces={[NS, 'ds-words', 'portal', 'shell', 'lists', 'returns-remake']}>
      <PortalShellView model={model.shell}>
        {body.kind === 'list' ? (
          <ReturnsListView model={body.model} />
        ) : body.kind === 'record' ? (
          <CaseRecordView model={body.model}>{body.thread ? <ThreadView model={body.thread} /> : null}</CaseRecordView>
        ) : (
          <NotInAccess admins={body.admins} homeHref={model.shell.prefix} />
        )}
      </PortalShellView>
    </WithMessages>
  )
}
