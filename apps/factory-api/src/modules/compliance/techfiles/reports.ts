import type { FastifyRequest } from 'fastify'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { actorOf } from '../../../core/context'
import { dayOf, officeOf, techfilesClock } from './common'
import { coveringCertificates, readFile, readItems } from './store'

/**
 * The Test reports tab (B-W2b-251; PRD-296 (h) and (i); design compliance.techfiles › Test reports, read-only): the style's
 * reports in one list — the recorded production-control tests (their lab, clause, sample, result, day and report file), the
 * files of the certificates that cover the style (the notified body's certificate and the type-test reports kept with it),
 * and the files linked to the file's points (h) and (i). "Link a report" is an item of point (i) (POST …/items).
 *
 *   GET /compliance/techfiles/:fileId/test-reports   compliance.certificates.view over the file's company
 */

export const REPORT_SOURCES = ['CONTROL_TEST', 'CERTIFICATE_FILE', 'TECHFILE_ITEM'] as const

export async function testReports(request: FastifyRequest, fileId: string) {
  const actor = actorOf(officeOf(request))
  const now = techfilesClock().now()
  return request.withClient(async (db) => {
    const file = await readFile(db, actor, fileId)
    const certificates = (await coveringCertificates(db, [file.styleId])).get(file.styleId) ?? []
    const byId = new Map(certificates.map((row) => [row.id, row]))
    const tests = await db.productionControlTest.findMany({
      where: { styleId: file.styleId, result: { not: null } },
      select: { id: true, reportNumber: true, testedBy: true, standardClause: true, sample: true, result: true, testedOn: true, batchNumber: true, test: true, testName: true, workOrder: { select: { batchNumber: true } }, labReportFile: { select: { id: true, originalName: true, sha256: true } } },
      orderBy: [{ testedOn: 'desc' }, { id: 'desc' }],
    })
    const certificateFiles = await db.storedFile.findMany({
      where: { recordType: 'Certificate', recordId: { in: certificates.map((row) => row.id) }, status: 'AVAILABLE' },
      select: { id: true, recordId: true, originalName: true, sha256: true, kind: true, availableAt: true },
      orderBy: [{ availableAt: 'desc' }, { id: 'desc' }],
    })
    const items = (await readItems(db, [file.id])).filter((item) => (item.point === 'H_CALCULATIONS' || item.point === 'I_TEST_REPORTS') && item.fileId !== null)
    const itemFiles = items.length ? await db.storedFile.findMany({ where: { id: { in: items.map((item) => item.fileId!) } }, select: { id: true, originalName: true, sha256: true, status: true, availableAt: true } }) : []
    const named = file.certificateId ? byId.get(file.certificateId) ?? null : null
    const ref = (row: { id: string; number: string } | null | undefined) => (row ? { id: row.id, number: row.number } : null)
    const reports = [
      ...tests.map((row) => ({
        source: 'CONTROL_TEST' as const,
        id: row.id,
        title: row.testName ? `${row.test.replace(/_/g, ' ').toLowerCase()} (${row.testName})` : row.test.replace(/_/g, ' ').toLowerCase(),
        reportNumber: row.reportNumber,
        lab: row.testedBy,
        standardClause: row.standardClause,
        sample: row.sample,
        result: row.result,
        date: dayOf(row.testedOn),
        batchNumber: row.batchNumber ?? row.workOrder?.batchNumber ?? null,
        file: row.labReportFile ? { id: row.labReportFile.id, name: row.labReportFile.originalName, sha256: row.labReportFile.sha256 } : null,
        certificate: ref(named),
      })),
      ...certificateFiles.map((row) => {
        const certificate = byId.get(row.recordId)
        return {
          source: 'CERTIFICATE_FILE' as const,
          id: row.id,
          title: row.kind === 'CERTIFICATE' ? `Certificate ${certificate?.number ?? ''}`.trim() : row.originalName,
          reportNumber: null,
          lab: null,
          standardClause: certificate?.standard ?? null,
          sample: null,
          result: null,
          date: dayOf(row.availableAt),
          batchNumber: null,
          file: { id: row.id, name: row.originalName, sha256: row.sha256 },
          certificate: ref(certificate),
        }
      }),
      ...itemFiles
        .filter((row) => row.status === 'AVAILABLE')
        .map((row) => ({
          source: 'TECHFILE_ITEM' as const,
          id: row.id,
          title: row.originalName,
          reportNumber: null,
          lab: null,
          standardClause: null,
          sample: null,
          result: null,
          date: dayOf(row.availableAt),
          batchNumber: null,
          file: { id: row.id, name: row.originalName, sha256: row.sha256 },
          certificate: ref(named),
        })),
    ]
    return { technicalFileId: file.id, reports, asOf: toUtcIso(now) }
  })
}
