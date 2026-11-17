'use client'

import type { Locale } from '../../../../lib/i18n/locales'
import { useLocale } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import { PortalShellView, type PortalShellViewModel } from '../../../shell/view/PortalShellView'
import { ThreadView, type ThreadViewModel } from '../../../shell/view/ThreadView'
import { NotInAccess } from '../../orders/parts'
import { NS } from '../model'
import { useJobWords } from '../words'
// ---- B-TH-277: the job's conversation docked beside the tabs (the portal record frame), as the live page draws it.
import { PortalRecordFrame } from '../../../shell/record/PortalRecordFrame'
import type { PortalFrameMode } from '../../../shell/record/model'
// ---- end B-TH-277
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
  // B-TH-277: `frame` — absent, the review frame's own width decides (phone first at 390: the "Messages" button; docked from 1280 px);
  // given, the narrow page whatever the width (its "Messages (2 new)" button, or the conversation open).
  | { kind: 'record'; model: JobRecordViewModel; thread: ThreadViewModel | null; frame?: { mode: PortalFrameMode; viewOpen?: boolean; newCount?: number } }
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
          <RecordBody body={body} />
        ) : body.kind === 'sheet' ? (
          <SheetView model={body.model} />
        ) : (
          <NotInAccess admins={body.admins} homeHref={model.shell.prefix} />
        )}
      </PortalShellView>
    </WithMessages>
  )
}

/** B-TH-277: one job in the portal record frame — its tab, and the job's conversation docked beside it. */
function RecordBody({ body }: { body: Extract<JobsCaseBody, { kind: 'record' }> }) {
  const { t } = useJobWords()
  return (
    <PortalRecordFrame thread={body.thread ? <ThreadView model={body.thread} /> : null} threadLabel={t('thread.label', { number: body.model.page?.job.number ?? '' })} design={body.frame}>
      <JobRecordView model={body.model} />
    </PortalRecordFrame>
  )
}
