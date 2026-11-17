'use client'

import { useLocale, useT } from '../../../../lib/i18n/provider'
import { OfficeRecordThread } from '../../../_shared/record-thread/OfficeRecordThread'
import type { TaskRow } from '../api'
import { DEPTH_NS } from '../model'
import { requestWords } from './request-words'

/**
 * B-TH-270 (threads plan TH-6, PL6; 08-tabs O-HOME-APV "Conversation → the thread docked in the window"): the request's own thread
 * (`ApprovalTask`) docked in the review window's right column, beside Change and Context & history — the Head with Activity's tools in
 * its "⋯" (R-ACT), the files line, the feed and the box. An approval is internal: notes between the approver and who asked, no party
 * (the API's resolver names none), so no "Reply to" and no customer or supplier files. Titled with the request in words from its codes
 * (B-W2b-382), in the person's language. Mounted by the page only with threads.read.
 */
export function RequestThread({ task }: { task: Pick<TaskRow, 'id' | 'companyId' | 'siteId' | 'kindLabel' | 'record'> }) {
  const t = useT(DEPTH_NS)
  const locale = useLocale()
  const words = requestWords(task, locale, t)
  return <OfficeRecordThread docked record={{ type: 'ApprovalTask', id: task.id, companyId: task.companyId, siteId: task.siteId }} title={words} recordLabel={words} party={null} />
}
