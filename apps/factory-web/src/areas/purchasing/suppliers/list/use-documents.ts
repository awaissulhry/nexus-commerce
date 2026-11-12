'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { useLiveBus } from '../../../../shell/live/use-live'
import { askForDocuments, readDocumentsSummary, readSuppliers, type DocumentsSummary, type SupplierDocuments, type SupplierRow } from '../depth/api'
import { ASK_MAX, depthCan, dueInstant, dueProblem, failedRead, LOADING, problemOf, ready, valueOf, type Read } from '../depth/model'
import { todayOf } from '../depth/use-depth'
import type { RequestRun } from './view/RequestDialog'

/** A supplier asked for its documents (the list's selection or the expiring view's). */
export interface AskTarget {
  readonly id: string
  readonly name: string
}

/**
 * The Suppliers list's W2b reads and the bulk ask (B-W2b-334): the documents summary of the company (the Documents column
 * and the "Documents expiring in 30 days" tile; read again on the suppliers' document events), the suppliers' names and
 * kinds for the expiring view (read when it opens), and Request documents N — one UPLOAD_DOCUMENT request per supplier
 * on its own record (its portal's Home; one waiting already is said, not doubled), one call at a time, each with its
 * outcome in words.
 */
export function useSupplierDocuments() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const can = useMemo(() => depthCan(session.permissions), [session.permissions])
  const companyId = session.company?.id ?? null
  const today = useMemo(() => todayOf(), [])
  const [summary, setSummary] = useState<Read<DocumentsSummary>>(LOADING)
  const [suppliers, setSuppliers] = useState<Read<readonly SupplierRow[]>>(LOADING)
  const reading = useRef(false)

  const load = useCallback(async () => {
    try {
      setSummary(ready(await readDocumentsSummary(api, companyId)))
    } catch (error) {
      setSummary(failedRead(problemOf(error)))
    }
  }, [api, companyId])

  const loadSuppliers = useCallback(async () => {
    if (reading.current) return
    reading.current = true
    try {
      setSuppliers(ready((await readSuppliers(api, companyId)).suppliers))
    } catch (error) {
      setSuppliers(failedRead(problemOf(error)))
    } finally {
      reading.current = false
    }
  }, [api, companyId])

  useEffect(() => {
    void load()
  }, [load])

  useLiveBus({
    onChange: (change) => {
      if (change.type.startsWith('supplier_document.') || change.type === 'party.created') void load()
    },
    onReconnect: () => void load(),
  })

  const byParty = useMemo(() => {
    const value = valueOf(summary)
    return value ? new Map<string, SupplierDocuments>(value.suppliers.map((row) => [row.partyId, row])) : null
  }, [summary])

  // ---- Request documents N ----
  const [run, setRun] = useState<RequestRun | null>(null)
  const open = (targets: readonly AskTarget[]) => setRun({ targets: targets.slice(0, ASK_MAX), due: '', tried: false, sending: false, results: [], done: false })
  const send = async () => {
    const current = run
    if (!current || current.sending) return
    if (dueProblem(current.due, today)) {
      setRun({ ...current, tried: true })
      return
    }
    setRun({ ...current, tried: true, sending: true, results: [] })
    const results: RequestRun['results'][number][] = []
    for (const target of current.targets) {
      try {
        const answer = await askForDocuments(api, target.id, { dueAt: dueInstant(current.due), ...(companyId ? { companyId } : {}) }, newIdempotencyKey())
        results.push({ id: target.id, name: target.name, outcome: answer.made ? 'asked' : 'already' })
      } catch (error) {
        results.push({ id: target.id, name: target.name, outcome: 'refused', problem: problemOf(error) })
      }
      setRun((value) => (value ? { ...value, results: [...results] } : value))
    }
    setRun((value) => (value ? { ...value, sending: false, done: true } : value))
  }

  return {
    can,
    today,
    summary,
    byParty,
    suppliers,
    reload: () => void load(),
    loadSuppliers: () => void loadSuppliers(),
    request: {
      run,
      open,
      onDue: (due: string) => setRun((value) => (value ? { ...value, due } : value)),
      onSend: () => void send(),
      onClose: () => setRun((value) => (value?.sending ? value : null)),
    },
  }
}

export type SupplierDocumentsState = ReturnType<typeof useSupplierDocuments>
