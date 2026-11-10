import { createElement } from 'react'
import { defineDesignScreen } from '../../../../../lib/design/design-screen'
import { failedRead, ready, reading } from '../../../../quality/_shared/model'
import { inShell, type RoleCase } from '../../../../quality/_shared/fixtures'
import { NOTICE_DRAFT, NOTICE_SENT } from '../fixtures'
import { NoticePdfView, type NoticePdfModel } from './view/NoticePdfView'

/**
 * SCR-329 — Authority notice (PDF), the window page of tab:rg-notice-pdf (B-W2b-271) — made-up notices only. The PDF itself
 * is the API's (made on the fly): the review shows the page around it (its loading, a failed PDF), the draft's and the
 * sent notice's words, the language choice, a cancelled notice, no permission, a failed read.
 */

interface PdfDesignModel {
  readonly role: RoleCase
  readonly page: NoticePdfModel
}

function PdfDesign({ model }: { model: PdfDesignModel }) {
  return inShell('/compliance/register', createElement(NoticePdfView, { model: model.page }), model.role)
}

const page = (over: Partial<NoticePdfModel>): NoticePdfModel => ({ allowed: true, notice: ready(NOTICE_DRAFT), language: 'en', pdf: reading(), ...over })

export const designScreen = defineDesignScreen<PdfDesignModel>({
  screen: 'SCR-329',
  title: 'Authority notice (PDF)',
  view: PdfDesign,
  cases: [
    { id: 'draft', label: 'A draft: to be submitted by a person (the PDF loading)', model: { role: 'owner', page: page({}) }, note: 'Two languages: German and English, one choice away.' },
    { id: 'sent', label: 'Sent: the day and the authority’s reference', model: { role: 'owner', page: page({ notice: ready(NOTICE_SENT), language: 'it' }) } },
    { id: 'cancelled', label: 'Cancelled: not sent', model: { role: 'owner', page: page({ notice: ready({ ...NOTICE_DRAFT, status: 'CANCELLED', cancelledAt: NOTICE_DRAFT.createdAt, cancelReason: 'Made-up.' }) }) } },
    { id: 'pdf-failed', label: 'The PDF could not be made (Try again)', model: { role: 'owner', page: page({ pdf: failedRead('problem.unavailable') }) } },
    { id: 'loading', label: 'Loading', model: { role: 'owner', page: page({ notice: reading(), pdf: null }) } },
    { id: 'error', label: 'The notice could not be read', model: { role: 'owner', page: page({ notice: failedRead('problem.notFound'), pdf: null }) } },
    { id: 'no-permission', label: 'Sales: no permission (which one, who grants it)', model: { role: 'sales', page: page({ allowed: false }) } },
  ],
})
