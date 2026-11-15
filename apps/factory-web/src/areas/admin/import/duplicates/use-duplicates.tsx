'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { isApiError } from '../../../../lib/api/errors'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { companyPrefix } from '../../../../lib/session/session'
import type { DuplicateRecordType } from '@nexus/factory-domain/imports/duplicates/rules'
import { importDuplicates, mergeRecords, previewMerge, scanDuplicates, type DuplicateScan, type ImportDuplicates as ImportAnswer, type MergePreview } from './api'
import { askOfPair, mergeNotice, type MergeAsk, type MergeDialogModel, type MergeNotice } from './model'
import { ImportDuplicatesPanel } from './view/ImportDuplicatesPanel'
import { MergeDialog } from './view/MergeDialog'
import { DuplicatesSection, type BulkMergeModel } from './view/DuplicatesSection'

/**
 * The containers of likely duplicates (B-W2b-427): they read through the API and hold the state; the views draw. Every
 * merge goes through the dialog (a person's decision) or the bulk confirm, each POST with the versions previewed.
 */

const MERGE_RIGHT = 'imports.duplicates.merge'

/** A failed call in this catalogue's words. */
export function dupProblem(error: unknown): string {
  if (!isApiError(error)) return 'dup.problem.other'
  switch (error.kind) {
    case 'conflict':
      return 'dup.problem.conflict'
    case 'forbidden':
    case 'step_up':
      return 'dup.problem.forbidden'
    case 'not_found':
      return 'dup.problem.notFound'
    case 'invalid':
      return 'dup.problem.invalid'
    case 'unavailable':
    case 'rate_limited':
      return 'dup.problem.busy'
    default:
      return 'dup.problem.other'
  }
}

/** The merge dialog: open it for a pair, swap the sides, merge; `onMerged` refreshes what the page shows. */
export function useMergeDialog(onMerged: () => void) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const prefix = companyPrefix(session.company?.code ?? '')
  const canMerge = session.permissions.includes(MERGE_RIGHT)
  const [dialog, setDialog] = useState<MergeDialogModel | null>(null)
  const asked = useRef<string | null>(null)

  const open = useCallback(
    (ask: MergeAsk) => {
      const key = `${ask.kept.id}:${ask.dropped.id}`
      asked.current = key
      setDialog({ ask, preview: null, problem: null, busy: false, canMerge, prefix })
      previewMerge(api, ask.recordType, ask.kept.id, ask.dropped.id).then(
        (preview) => {
          if (asked.current === key) setDialog((current) => (current ? { ...current, preview, ask: { ...current.ask, kept: { id: preview.kept.id, code: preview.kept.code }, dropped: { id: preview.dropped.id, code: preview.dropped.code } } } : current))
        },
        (error: unknown) => {
          if (asked.current === key) setDialog((current) => (current ? { ...current, problem: dupProblem(error) } : current))
        },
      )
    },
    [api, canMerge, prefix],
  )

  const element = (
    <MergeDialog
      model={dialog}
      actions={{
        onClose: () => {
          asked.current = null
          setDialog(null)
        },
        onSwap: () => {
          if (dialog) open({ recordType: dialog.ask.recordType, kept: dialog.ask.dropped, dropped: dialog.ask.kept })
        },
        onMerge: (reason) => {
          const preview = dialog?.preview
          if (!dialog || !preview) return
          setDialog({ ...dialog, busy: true, problem: null })
          mergeRecords(api, preview.recordType, { keptId: preview.kept.id, droppedId: preview.dropped.id, keptVersion: preview.kept.version, droppedVersion: preview.dropped.version, reason })
            .then(() => {
              asked.current = null
              setDialog(null)
              onMerged()
            })
            .catch((error: unknown) => setDialog((current) => (current ? { ...current, busy: false, problem: dupProblem(error) } : current)))
        },
      }}
    />
  )
  return { open, element, canMerge, prefix }
}

/**
 * "Possible duplicates" in the import wizard's check and result (mounted by the wizard with the job): reads
 * GET /imports/:id/duplicates when the job is planned or applied, offers the merge after the apply.
 */
export function ImportDuplicates({ job }: { job: { readonly id: string; readonly status: string; readonly importerKey: string } }) {
  const api = useOfficeApi()
  const [answer, setAnswer] = useState<ImportAnswer | null>(null)
  const [state, setState] = useState<'loading' | 'error' | 'ready'>('loading')
  const checked = job.importerKey === 'parties.parties' || job.importerKey === 'product.materials'
  const phase = job.status === 'APPLIED' ? 'result' : 'check'
  const load = useCallback(() => {
    if (!checked) return
    setState('loading')
    importDuplicates(api, job.id).then(
      (next) => {
        setAnswer(next)
        setState('ready')
      },
      () => setState('error'),
    )
  }, [api, checked, job.id])
  useEffect(() => {
    if (job.status === 'PLANNED' || job.status === 'APPLIED' || job.status === 'FAILED') load()
  }, [load, job.status])
  const merge = useMergeDialog(load)
  if (!checked || !['PLANNED', 'APPLIED', 'FAILED'].includes(job.status)) return null
  return (
    <>
      <ImportDuplicatesPanel model={{ state, answer, phase, prefix: merge.prefix, canMerge: merge.canMerge }} actions={{ onRetry: load, onMerge: merge.open }} />
      {merge.element}
    </>
  )
}

/** The record types this person sees likely duplicates of (the view permission of each). */
function typesOf(permissions: readonly string[]): DuplicateRecordType[] {
  return [...(permissions.includes('parties.view') ? (['PARTY'] as const) : []), ...(permissions.includes('product.materials.view') ? (['MATERIAL'] as const) : [])]
}

/** "Possible duplicates" on Admin › Import & export: the pairs, Merge… per pair, Merge N after one confirm. */
export function PossibleDuplicates() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const types = useMemo(() => typesOf(session.permissions), [session.permissions])
  const [recordType, setRecordType] = useState<DuplicateRecordType>(types[0] ?? 'PARTY')
  const [scan, setScan] = useState<DuplicateScan | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<readonly string[]>([])
  const [bulk, setBulk] = useState<BulkMergeModel | null>(null)
  const [notice, setNotice] = useState<MergeNotice | null>(null)
  const load = useCallback(() => {
    if (types.length === 0) return
    setLoading(true)
    scanDuplicates(api, recordType).then(
      (next) => {
        setScan(next)
        setProblem(null)
        setLoading(false)
      },
      (error: unknown) => {
        setProblem(dupProblem(error))
        setLoading(false)
      },
    )
  }, [api, recordType, types.length])
  useEffect(() => {
    setScan(null)
    setSelected([])
    load()
  }, [load])
  const merge = useMergeDialog(() => {
    setNotice(mergeNotice(1, 0))
    load()
  })
  if (types.length === 0) return null
  const pairsOf = (keys: readonly string[]) => (scan?.pairs ?? []).filter((pair) => keys.includes(pair.key))
  return (
    <>
      <DuplicatesSection
        model={{ recordType, types, scan, problem, loading, prefix: merge.prefix, canMerge: merge.canMerge, selected, bulk, notice }}
        actions={{
          onType: (next) => {
            setRecordType(next)
            setNotice(null)
          },
          onRetry: load,
          onSelect: setSelected,
          onMerge: merge.open,
          onDismissNotice: () => setNotice(null),
          onBulk: (keys) => {
            if (!keys) return setBulk(null)
            const pairs = pairsOf(keys)
            setBulk({ pairs, previews: {}, busy: false, problem: null })
            // One preview per pair, one after the other (each reads what uses the duplicate).
            void (async () => {
              for (const pair of pairs) {
                const ask = askOfPair(recordType, pair)
                const preview: MergePreview | 'failed' = await previewMerge(api, recordType, ask.kept.id, ask.dropped.id).catch(() => 'failed' as const)
                setBulk((current) => (current ? { ...current, previews: { ...current.previews, [pair.key]: preview } } : current))
              }
            })()
          },
          onBulkGo: (reason) => {
            const current = bulk
            if (!current) return
            setBulk({ ...current, busy: true, problem: null })
            void (async () => {
              let merged = 0
              let refused = 0
              for (const pair of current.pairs) {
                const preview = current.previews[pair.key]
                if (!preview || preview === 'failed' || preview.refusals.length > 0) continue
                try {
                  await mergeRecords(api, recordType, { keptId: preview.kept.id, droppedId: preview.dropped.id, keptVersion: preview.kept.version, droppedVersion: preview.dropped.version, reason })
                  merged += 1
                } catch {
                  refused += 1
                }
              }
              setBulk(null)
              setSelected([])
              setNotice(mergeNotice(merged, refused))
              load()
            })()
          },
        }}
      />
      {merge.element}
    </>
  )
}
