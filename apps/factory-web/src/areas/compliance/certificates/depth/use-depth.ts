'use client'

import { useCallback, useEffect, useState } from 'react'
import type { ApiClient } from '../../../../lib/api/client'
import { isApiError } from '../../../../lib/api/errors'
import { failedRead, problemKey, reading, ready, type Read } from '../../../quality/_shared/model'
import type { CertCan } from '../model'
import { getDepth, listBodies, listSuppliers, setBase, setLevels, setNotifiedBody, setSupplier, type Depth, type NotifiedBody, type SupplierOption } from './api'
import { blankDepthDraft, levelsDraftOf, type DepthDialog, type DepthDraft, type DepthModel } from './model'

/** The API's sentences of a refusal (data, English) for the lines under our words. */
const issueLines = (error: unknown): string[] => (isApiError(error) ? [...error.issues.map((issue) => issue.message ?? '').filter(Boolean), ...(error.issues.length === 0 && error.kind === 'conflict' ? [error.message] : [])] : [])

function writeProblem(error: unknown): string {
  if (!isApiError(error)) return 'write.failed'
  if (error.kind === 'conflict') return error.issues.some((issue) => /refusal\//.test(String((issue as { path?: unknown }).path ?? ''))) ? 'write.refused' : 'write.conflict'
  if (error.kind === 'forbidden') return 'held.manage'
  if (error.kind === 'invalid') return 'write.invalid'
  if (error.kind === 'not_found') return 'write.notFound'
  return 'write.failed'
}

export interface DepthActions {
  onRetry?: () => void
  onDialog?: (dialog: DepthDialog | null) => void
  onDraft?: (patch: Partial<DepthDraft>) => void
  onPickBody?: () => void
  onClearBody?: () => void
  onLevels?: () => void
  onBase?: () => void
  onSupplier?: () => void
}

/**
 * Certificates in depth on the record (B-W2b-255; the certificate record mounts it, the views only read its model): reads
 * the depth (`GET /compliance/certificates/:id/depth`) while the Coverage or Notified body tab is open, the directory's
 * active bodies when a body is picked, the suppliers when a part's supplier is named, and runs each write with the version
 * read. A write moves the certificate's version: `onCertificateChanged` reads the record again.
 */
export function useDepth(input: { api: ApiClient; certificateId: string; can: CertCan; active: boolean; onCertificateChanged: () => void }) {
  const { api, certificateId, can, active, onCertificateChanged } = input
  const [depth, setDepth] = useState<Read<Depth>>(reading())
  const [bodies, setBodies] = useState<Read<NotifiedBody[]> | null>(null)
  const [suppliers, setSuppliers] = useState<Read<SupplierOption[]> | null>(null)
  const [dialog, setDialog] = useState<DepthDialog | null>(null)
  const [draft, setDraft] = useState<DepthDraft>(blankDepthDraft())
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [lines, setLines] = useState<readonly string[]>([])

  const load = useCallback(async () => {
    if (!can.view) return
    try {
      setDepth(ready(await getDepth(api, certificateId)))
    } catch (error) {
      setDepth(failedRead(problemKey(error)))
    }
  }, [api, can.view, certificateId])

  useEffect(() => {
    if (active) void load()
  }, [active, load])

  const open = useCallback(
    (next: DepthDialog | null) => {
      setDialog(next)
      setProblem(null)
      setLines([])
      const read = depth.value
      const part = next?.kind === 'supplier' ? read?.boughtIn.find((entry) => entry.coverageId === next.coverageId) : undefined
      setDraft({
        ...blankDepthDraft(),
        bodyId: next?.kind === 'pickBody' ? (read?.body.directory?.id ?? read?.body.matching[0]?.id ?? '') : '',
        levels: next?.kind === 'levels' && read ? levelsDraftOf(read) : {},
        baseId: next?.kind === 'base' ? (read?.ownBrand.base?.id ?? read?.ownBrand.candidates[0]?.id ?? '') : '',
        supplierId: part?.supplier?.id ?? '',
        articleCode: part?.supplierArticleCode ?? '',
      })
      if (next?.kind === 'pickBody' && !bodies) {
        setBodies(reading())
        listBodies(api, { status: 'ACTIVE' })
          .then((answer) => setBodies(ready(answer.bodies)))
          .catch((error) => setBodies(failedRead(problemKey(error))))
      }
      if (next?.kind === 'supplier' && !suppliers && can.parties) {
        setSuppliers(reading())
        listSuppliers(api)
          .then((list) => setSuppliers(ready(list)))
          .catch((error) => setSuppliers(failedRead(problemKey(error))))
      }
    },
    [api, bodies, can.parties, depth.value, suppliers],
  )

  const run = async (write: (read: Depth) => Promise<Depth>) => {
    const read = depth.value
    if (!read) return
    setBusy(true)
    setProblem(null)
    setLines([])
    try {
      setDepth(ready(await write(read)))
      setDialog(null)
      onCertificateChanged()
    } catch (error) {
      setProblem(writeProblem(error))
      setLines(issueLines(error))
      if (isApiError(error) && error.kind === 'conflict') void load()
    } finally {
      setBusy(false)
    }
  }

  const model: DepthModel = { depth, bodies, suppliers, dialog, draft, busy, problem, lines }
  const actions: DepthActions = {
    onRetry: () => void load(),
    onDialog: open,
    onDraft: (patch) => setDraft((current) => ({ ...current, ...patch })),
    onPickBody: () => void run((read) => setNotifiedBody(api, read.certificate, draft.bodyId)),
    onClearBody: () => void run((read) => setNotifiedBody(api, read.certificate, null)),
    onLevels: () => {
      const levels = Object.fromEntries(Object.entries(draft.levels).filter(([, value]) => value.trim() !== ''))
      void run((read) => setLevels(api, read.certificate, Object.keys(levels).length > 0 ? levels : null))
    },
    onBase: () => void run((read) => setBase(api, read.certificate, draft.baseId)),
    onSupplier: () => {
      if (dialog?.kind !== 'supplier') return
      const coverageId = dialog.coverageId
      void run((read) => {
        const part = read.boughtIn.find((entry) => entry.coverageId === coverageId)
        if (!part) return Promise.resolve(read)
        return setSupplier(api, read.certificate.id, part, draft.supplierId, draft.articleCode.trim() || null)
      })
    },
  }
  return { model, actions, reload: load }
}
