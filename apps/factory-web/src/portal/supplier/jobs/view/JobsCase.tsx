'use client'

import type { Locale } from '../../../../lib/i18n/locales'
import { useLocale } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import { PortalShellView, type PortalShellViewModel } from '../../../shell/view/PortalShellView'
import { ThreadView, type ThreadViewModel } from '../../../shell/view/ThreadView'
import { NotInAccess } from '../../orders/parts'
import { NS } from '../model'
import { JobRecordView, type JobRecordViewModel } from './JobRecordView'
import { JobsListView, type JobsListViewModel } from './JobsListView'
import { SheetView, type SheetViewModel } from './SheetView'

/**
 * SCR-192 / SCR-193 as one case of the design review (B-W2b-181): the portal frame (B-W2b-173's PortalShellView, its band
 * filled as the live page fills it) around the workshop's Jobs, one job or its sheet, with made-up data. The live pages
 * compose the same views.
 */

export type JobsCaseBody =
  | { kind: 'list'; model: JobsListViewModel }
  | { kind: 'record'; model: JobRecordViewModel; thread: ThreadViewModel | null }
  | { kind: 'sheet'; model: SheetViewModel }
  | { kind: 'noAccess'; admins: readonly string[] }

export interface JobsCaseModel {
  shell: PortalShellViewModel
  body: JobsCaseBody
}

/** A case is drawn in the page's language: its made-up words come in both. */
export type JobsCaseBuilder = (locale: Locale) => JobsCaseModel

export function JobsCase({ model: build }: { model: JobsCaseBuilder }) {
  const locale = useLocale()
  const model = build(locale)
  const body = model.body
  return (
    <WithMessages namespaces={[NS, 'ds-words', 'portal', 'shell', 'photo-kit', 'portal-supplier-orders']}>
      <PortalShellView model={model.shell}>
        {body.kind === 'list' ? (
          <JobsListView model={body.model} />
        ) : body.kind === 'record' ? (
          <JobRecordView model={body.model}>{body.thread ? <ThreadView model={body.thread} /> : null}</JobRecordView>
        ) : body.kind === 'sheet' ? (
          <SheetView model={body.model} />
        ) : (
          <NotInAccess admins={body.admins} homeHref={model.shell.prefix} />
        )}
      </PortalShellView>
    </WithMessages>
  )
}
