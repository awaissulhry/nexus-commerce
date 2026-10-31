'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useSearchParams } from 'next/navigation'
import { isApiError } from '../../../../lib/api/errors'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { WithMessages } from '../../../../record-panels/i18n'
import { useLiveChanges } from '../../../../record-panels/live'
import { failed, libraryCan, readProblem, ready, reading, writeProblem, type Notice, type WriteProblem } from '../../library/model'
import {
  addColour,
  archiveMaterial,
  certificatesFor,
  findSuppliers,
  getMaterial,
  listLibraryColours,
  lotsOf,
  reactivateMaterial,
  setStandardCost,
  stockOf,
  updateColour,
  updateMaterial,
  type ColourInput,
  type MaterialColour,
  type MaterialPatch,
  type MaterialView,
} from '../api'
import { tabOf } from '../model'
import { listSources } from '../../../purchasing/suppliers/sources/api'
import { sourcesCan, type SourcesRead, type SupplierPricesModel } from '../../../purchasing/suppliers/sources/model'
import { readProblem as sourcesProblem } from '../../../_shared/buying/model'
import type { MaterialDialog, MaterialLoad, MaterialRecordViewModel } from './record-model'
import { MaterialRecordView } from './view/MaterialRecordView'

/**
 * `/w/<company>/products/materials/<id>` (SCR-048): reads the material, then beside it what the person may see — the
 * colour library, the certificates covering it (a PPE component), its lots' test results, its stock — each failing on its
 * own. One write at a time with the version read (COL-078): a 409 reads it again and says so. Live material.* events of
 * this material from someone else show "Changed meanwhile · Reload" rather than moving the form under the cursor.
 */
export function MaterialRecord({ materialId }: { materialId: string }) {
  return (
    <WithMessages namespaces={['library']}>
      <Container materialId={materialId} />
    </WithMessages>
  )
}

function Container({ materialId }: { materialId: string }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const pathname = usePathname()
  const params = useSearchParams()
  const can = useMemo(() => libraryCan(session.permissions), [session.permissions])
  const prefix = pathname.replace(/\/products\/materials\/[^/]+\/?$/, '')
  const tab = tabOf(params?.get('tab'), can)
  const [material, setMaterial] = useState<MaterialLoad>({ status: 'loading' })
  const [libraryColours, setLibraryColours] = useState<MaterialRecordViewModel['libraryColours']>(null)
  const [certificates, setCertificates] = useState<MaterialRecordViewModel['certificates']>(null)
  const [lots, setLots] = useState<MaterialRecordViewModel['lots']>(null)
  const [stock, setStock] = useState<MaterialRecordViewModel['stock']>(null)
  const [suppliers, setSuppliers] = useState<MaterialRecordViewModel['suppliers']>(null)
  const [save, setSave] = useState<MaterialRecordViewModel['save']>({ state: 'idle', at: null })
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [changed, setChanged] = useState<{ at: string } | null>(null)
  const [dialog, setDialog] = useState<MaterialDialog | null>(null)
  const [refused, setRefused] = useState<WriteProblem | null>(null)
  // B-W2a-69: Purchasing's approved sources of this material (Supplier prices), with purchasing.view only.
  const sourceCan = useMemo(() => sourcesCan(session.permissions), [session.permissions])
  const [sources, setSources] = useState<SourcesRead>({ status: 'loading' })
  const writing = useRef(false)
  const current = material.status === 'ready' ? material.value : null

  const load = useCallback(async () => {
    try {
      const value = await getMaterial(api, materialId)
      setMaterial({ status: 'ready', value })
      setChanged(null)
      return value
    } catch (error) {
      if (isApiError(error) && error.kind === 'not_found') setMaterial({ status: 'notFound' })
      else if (isApiError(error) && error.kind === 'forbidden') setMaterial({ status: 'forbidden' })
      else setMaterial({ status: 'error', problem: readProblem(error) })
      return null
    }
  }, [api, materialId])

  const loadBeside = useCallback(
    (value: MaterialView) => {
      if (can.styles)
        listLibraryColours(api)
          .then(setLibraryColours)
          .catch(() => setLibraryColours([]))
      if (can.certificates && value.isPpeComponent) {
        setCertificates(reading())
        certificatesFor(api, value.id)
          .then((rows) => setCertificates(ready(rows)))
          .catch((error: unknown) => setCertificates(failed(readProblem(error))))
      } else setCertificates(null)
      if (can.lots) {
        setLots(reading())
        lotsOf(api, value.id)
          .then((answer) => setLots(ready(answer)))
          .catch((error: unknown) => setLots(failed(readProblem(error))))
      }
      if (can.stock) {
        setStock(reading())
        stockOf(api, value.id)
          .then((answer) => setStock(ready(answer)))
          .catch((error: unknown) => setStock(failed(readProblem(error))))
      }
    },
    [api, can],
  )

  useEffect(() => {
    void load().then((value) => {
      if (value) loadBeside(value)
    })
  }, [load, loadBeside])

  const companyId = session.company?.id
  const loadSources = useCallback(() => {
    if (!sourceCan.view) return
    setSources({ status: 'loading' })
    listSources(api, { itemId: materialId, ...(companyId ? { companyId } : {}), limit: 200 })
      .then((page) => setSources({ status: 'ready', rows: page.items, more: page.nextCursor !== null }))
      .catch((error: unknown) => setSources({ status: 'error', problem: sourcesProblem(error) }))
  }, [api, companyId, materialId, sourceCan.view])
  useEffect(() => {
    if (tab === 'suppliers') loadSources()
  }, [tab, loadSources])
  const tabRef = useRef(tab)
  tabRef.current = tab
  const loadSourcesRef = useRef(loadSources)
  loadSourcesRef.current = loadSources

  useLiveChanges({
    onChange: (change) => {
      // B-W2a-69: a source of this material changed in Purchasing: the read-only Supplier prices are read again.
      if (change.type.startsWith('supplier_item.') && change.fields.itemId === materialId && tabRef.current === 'suppliers') loadSourcesRef.current()
      if (!change.type.startsWith('material.') || writing.current) return
      const subject = change.fields.itemId
      if (subject === materialId) setChanged({ at: new Date().toISOString() })
    },
  })

  /** One write: the version read, the answer is the new material; a refusal reads it again when it moved. */
  const write = async (run: (value: MaterialView) => Promise<MaterialView>, success?: Notice): Promise<boolean> => {
    if (!current || writing.current) return false
    writing.current = true
    setBusy(true)
    setSave({ state: 'saving', at: save.at })
    setRefused(null)
    try {
      const value = await run(current)
      setMaterial({ status: 'ready', value })
      setSave({ state: 'idle', at: new Date().toISOString() })
      if (success) setNotice(success)
      return true
    } catch (error) {
      const problem = writeProblem(error)
      setRefused(problem)
      setSave({ state: 'failed', at: save.at })
      setNotice({ key: problem.key, tone: 'danger' })
      if (problem.reload) void load()
      return false
    } finally {
      writing.current = false
      setBusy(false)
    }
  }

  const supplierPrices: SupplierPricesModel = { prefix, can: { view: sourceCan.view, cost: sourceCan.cost }, read: sources, defaultSupplier: current?.defaultSupplier ?? null }
  const model: MaterialRecordViewModel = { prefix, can, tab, material, libraryColours, certificates, lots, stock, suppliers, save, busy, notice, changed, dialog, refused, supplierPrices }

  return (
    <MaterialRecordView
      model={model}
      actions={{
        onRetry: () => void load().then((value) => value && loadBeside(value)),
        onReload: () => void load(),
        onSave: (patch: MaterialPatch) => write((value) => updateMaterial(api, value, patch)),
        onSetCost: (cost, reason) => write((value) => setStandardCost(api, value, cost, reason || undefined), { key: 'material.notice.costSet', tone: 'success' }),
        onArchive: (reason) => write((value) => archiveMaterial(api, value, reason || undefined), { key: 'material.notice.archived', tone: 'success' }),
        onReactivate: () => void write((value) => reactivateMaterial(api, value), { key: 'material.notice.reactivated', tone: 'success' }),
        onAddColour: (colour: ColourInput) => write(() => addColour(api, materialId, colour), { key: 'material.notice.colourAdded', tone: 'success', params: { code: colour.code } }),
        onUpdateColour: (colour: MaterialColour, patch) => write(() => updateColour(api, materialId, colour, patch)),
        onColoursStatus: async (ids, status) => {
          let done = 0
          for (const id of ids) {
            const value = material.status === 'ready' ? material.value : null
            const colour = value?.colours.find((entry) => entry.id === id)
            if (!colour || colour.status === status) continue
            // Each colour keeps its own version; the material's answer carries the new one for the next.
            const ok = await write(() => updateColour(api, materialId, colour, { status }))
            if (!ok) return false
            done++
          }
          setNotice({ key: status === 'ARCHIVED' ? 'material.notice.coloursArchived' : 'material.notice.coloursRestored', tone: 'success', params: { count: done } })
          return true
        },
        onSupplierSearch: (q) => {
          setSuppliers({ q, results: null })
          findSuppliers(api, q)
            .then((results) => setSuppliers((now) => (now && now.q === q ? { q, results } : now)))
            .catch(() => setSuppliers({ q, results: [] }))
        },
        onDialog: setDialog,
        onDismissNotice: () => setNotice(null),
        onRetrySupplierPrices: loadSources,
      }}
    />
  )
}
