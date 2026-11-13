'use client'

import { useLocale, useT } from '../../../../lib/i18n/provider'
import { RecordPanels } from '../../../../record-panels/RecordPanels'
import type { TaskRow } from '../api'
import { DEPTH_NS } from '../model'
import { requestWords } from './request-words'

/**
 * The review's Conversation tab (B-W2b-382): the request's own thread (`ApprovalTask`), titled with the request in words from
 * its codes. Drawn inside the inbox's catalogues (the review renders it), so it says the title in the person's language.
 */
export function RequestPanels({ task }: { task: Pick<TaskRow, 'id' | 'companyId' | 'siteId' | 'kindLabel' | 'record'> }) {
  const t = useT(DEPTH_NS)
  const locale = useLocale()
  return <RecordPanels record={{ type: 'ApprovalTask', id: task.id, companyId: task.companyId, siteId: task.siteId }} title={requestWords(task, locale, t)} tab="thread" />
}
