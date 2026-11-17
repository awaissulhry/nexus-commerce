import { createElement, useEffect, useState } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { demoPdf } from '../../../../shell/design-data'
import { failedRead, ready, reading } from '../../_shared/model'
import type { RoleCase } from '../../_shared/fixtures'
import { inDepthShell, REPORTS } from '../depth/demo/fixtures'
import { InspectionReportView, type ReportModel } from './view/InspectionReportView'

/**
 * SCR-076-report — the inspection report window (design tab:qi-report-pdf, a new tab from the record's ⋯ and the list's row
 * verbs), made-up data: the preview in Italian or English, Keep a version, the kept versions, Share report link on a packed
 * Demo shipment (a newer version takes the older copy off the link), the refusals, the states and the roles.
 */

interface ReportCase {
  readonly role: RoleCase
  readonly model: ReportModel
}

const SHARE: ReportModel['share'] = { shipmentId: REPORTS.shipments[0]!.id, version: null, send: false, busy: false, problem: null, lines: [], done: null }

// ── B-TH-232 (W16): a work order that also makes garments for another customer — its report goes to no single customer; the
// shipment's certificate of conformity is offered instead (made-up). ──
const SHARED_SHIPMENT = { id: '99210000-0000-4000-8000-000000000003', number: 'DEMO-SH-0044', status: 'PACKED', customer: 'Demo Moto S.r.l.', shareable: false, held: 'SHARED_PRODUCTION' as const }
const SHARED_REPORTS = { ...REPORTS, shipments: [SHARED_SHIPMENT] }
const CERTIFICATE: NonNullable<ReportModel['certificate']> = { may: true, busy: false, problem: null, lines: [], done: null }
// ── end B-TH-232 ──

const model = (over: Partial<ReportModel> = {}, role: RoleCase = 'owner'): ReportCase => ({
  role,
  model: { allowed: true, language: 'it', reports: ready(REPORTS), pdf: demoPdf(['Rapporto di ispezione DEMO-INS-0010', 'ANTEPRIMA - non conservato']), pdfProblem: null, keeping: false, kept: null, keepProblem: null, canSend: true, shareFirst: false, share: SHARE, ...over },
})

function ReportDesign({ model: value }: { model: ReportCase }) {
  const [share, setShare] = useState(value.model.share)
  useEffect(() => setShare(value.model.share), [value])
  return inDepthShell(
    '/quality/inspections/report',
    createElement(InspectionReportView, { model: { ...value.model, share }, actions: { onShareDraft: (draft) => setShare((current) => ({ ...current, ...draft, done: null, problem: null })) } }),
    value.role,
  )
}

export const designScreen = defineDesignScreen<ReportCase>({
  screen: 'SCR-076-report',
  title: 'Inspections: inspection report (PDF)',
  view: ReportDesign,
  cases: [
    { id: 'preview', label: 'The preview in Italian, the kept versions, Share on DEMO-SH-0042', model: model(), note: 'Made now, kept nowhere until Keep (its banner says so); Print prints it.' },
    { id: 'english', label: 'In English', model: model({ language: 'en', pdf: demoPdf(['Inspection report DEMO-INS-0010', 'PREVIEW - not kept']) }) },
    { id: 'share-first', label: 'Opened from "Share report link…": the share part first', model: model({ shareFirst: true }) },
    { id: 'kept', label: 'Kept: version 3', model: model({ kept: { version: 3, language: 'it', made: true } }) },
    { id: 'kept-same', label: 'Keep with the same contents: version 2 stands', model: model({ kept: { version: 2, language: 'it', made: false } }) },
    { id: 'shared', label: 'Shared and mailed (the older copy taken off the link)', model: model({ share: { ...SHARE, send: true, done: { shipment: 'DEMO-SH-0042', version: 2, sent: true, withdrawn: 1 } } }) },
    { id: 'share-refused', label: 'Share refused: the shipment carries none of these garments', model: model({ share: { ...SHARE, problem: 'share.held.NOT_ON_SHIPMENT', lines: ['DEMO-SH-0042 carries no garment of DEMO-WO-0142.'] } }) },
    { id: 'share-draft', label: 'A draft shipment picked: Share held (not packed yet)', model: model({ share: { ...SHARE, shipmentId: REPORTS.shipments[1]!.id } }) },
    { id: 'no-versions', label: 'No version kept yet: Share held until one is kept', model: model({ reports: ready({ ...REPORTS, versions: [], shares: [] }) }) },
    // B-TH-232 (W16): the work order also makes another customer's garments.
    { id: 'shared-production', label: 'A work order of several customers: the report goes to none; the shipment’s certificate of conformity instead', model: model({ reports: ready(SHARED_REPORTS), share: { ...SHARE, shipmentId: SHARED_SHIPMENT.id }, certificate: CERTIFICATE }), note: 'The words name the work order, never the other customer.' },
    { id: 'shared-production-done', label: 'The certificate of conformity shared on the shipment', model: model({ reports: ready(SHARED_REPORTS), share: { ...SHARE, shipmentId: SHARED_SHIPMENT.id }, certificate: { ...CERTIFICATE, done: { shipment: SHARED_SHIPMENT.number, version: 1 } } }) },
    { id: 'shared-production-held', label: 'The certificate cannot be made yet: the reasons below', model: model({ reports: ready(SHARED_REPORTS), share: { ...SHARE, shipmentId: SHARED_SHIPMENT.id }, certificate: { ...CERTIFICATE, problem: 'certificate.held.NOT_CERTIFIABLE', lines: ['DEMO-SH-0044: 2 garments wait for their final release.'] } }) },
    { id: 'no-shipment', label: 'No shipment carries these garments yet', model: model({ reports: ready({ ...REPORTS, shipments: [], shares: [] }) }) },
    { id: 'no-send', label: 'Without shipping.manage: "and mail the link" held with the reason', model: model({ canSend: false }, 'inspector') },
    { id: 'read-only', label: 'Read-only: Keep and Share held with the reason', model: model({ reports: ready({ ...REPORTS, may: { make: false, share: false } }), canSend: false }, 'readOnly') },
    { id: 'not-signed', label: 'An open inspection: the report comes after the signature', model: model({ reports: ready({ ...REPORTS, inspection: { ...REPORTS.inspection, status: 'OPEN', signed: false }, versions: [], shares: [] }), pdf: null }) },
    { id: 'loading', label: 'Being made', model: model({ reports: reading(), pdf: null }) },
    { id: 'pdf-failed', label: 'The report could not be made', model: model({ pdf: null, pdfProblem: 'problem.unavailable' }) },
    { id: 'error', label: 'The versions could not be read', model: model({ reports: failedRead('problem.unavailable'), pdf: null }) },
    { id: 'no-permission', label: 'Sales: no quality.inspections.view', model: model({ allowed: false }, 'sales') },
  ],
})
