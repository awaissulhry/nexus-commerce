'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { isApiError } from '../../../../lib/api/errors'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { WithMessages } from '../../../../record-panels/i18n'
import { getBundles, getCutLog, getTicketPrinters, getWorkOrder, reprintBundle, type CutLog, type TicketPrinters, type WorkOrder, type WorkOrderBundles } from '../../_shared/api'
import { useCoalesced, useLive } from '../../_shared/hooks'
import { getAvailability, reserveHides } from '../../work-orders/daily/api'
import { getAllocated, getRecuts, getWorkOrderYield, recutDone, voidBundle, type Allocation, type Replacement, type WorkOrderYield } from '../api'
import { CUTTING_NAMESPACE, cutOf, cuttingCanOf, loading, phrase, readProblem, tabOf, writeProblem, type Part } from '../model'
import type { AllocModel } from '../view/CutDialogs'
import { CutRecordView, type CutDialog, type CutRecordModel } from './view/CutRecordView'

const TIME_ZONE = 'Europe/Rome'

/**
 * `/w/<company>/production/cutting/<work order>` (SCR-238, the Cut record; `?tab=lay|pieces|yield|tickets`): the work
 * order, its cut log, yield, recuts, allocated hides, bundles and ticket printers, each read on its own (a part that
 * fails says so with Try again; the others still show), live cut, hide, bundle and recut events of this work order, and
 * the writes: Allocate hides (reserved whole), a recut marked cut, a ticket reprinted with its reason, a bundle voided.
 */
export function CutRecord({ workOrderId }: { workOrderId: string }) {
  return (
    <WithMessages namespaces={[CUTTING_NAMESPACE, 'lists']}>
      <Container workOrderId={workOrderId} />
    </WithMessages>
  )
}

function Container({ workOrderId }: { workOrderId: string }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const prefix = pathname.replace(/\/production\/cutting\/[^/]+\/?$/, '')
  const can = useMemo(() => cuttingCanOf(session.permissions), [session.permissions])
  const tab = tabOf(params?.get('tab'))

  const [workOrder, setWorkOrder] = useState<CutRecordModel['workOrder']>({ status: 'loading', value: null, problem: null })
  const [log, setLog] = useState<Part<CutLog>>(loading())
  const [figures, setFigures] = useState<Part<WorkOrderYield>>(loading())
  const [recuts, setRecuts] = useState<Part<readonly Replacement[]>>(loading())
  const [allocated, setAllocated] = useState<Part<readonly Allocation[]>>(loading())
  const [bundles, setBundles] = useState<Part<WorkOrderBundles>>(loading())
  const [printers, setPrinters] = useState<Part<TicketPrinters>>(loading())
  const [dialog, setDialog] = useState<CutDialog | null>(null)
  const [alloc, setAlloc] = useState<AllocModel | null>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<CutRecordModel['problem']>(null)
  const [notice, setNotice] = useState<CutRecordModel['notice']>(null)
  const writeKey = useRef<string | null>(null)

  const readable = can.view && can.workOrders
  const part = useCallback(<T,>(read: () => Promise<T>, set: (part: Part<T>) => void) => {
    read()
      .then((value) => set({ value, problem: null }))
      .catch((error: unknown) => set({ value: null, problem: readProblem(error) }))
  }, [])

  const loadParts = useCallback(() => {
    part(() => getCutLog(api, workOrderId), setLog)
    part(() => getWorkOrderYield(api, workOrderId), setFigures)
    part(() => getBundles(api, workOrderId), setBundles)
    if (can.scrap) part(() => getRecuts(api, workOrderId), setRecuts)
    else setRecuts({ value: [], problem: null })
    if (can.stock) part(() => getAllocated(api, workOrderId), setAllocated)
    if (can.bundles) part(() => getTicketPrinters(api, workOrderId), setPrinters)
  }, [api, workOrderId, can.scrap, can.stock, can.bundles, part])

  const load = useCallback(async () => {
    if (!readable) return
    try {
      const value: WorkOrder = await getWorkOrder(api, workOrderId)
      setWorkOrder({ status: 'ready', value, problem: null })
      loadParts()
    } catch (error) {
      if (isApiError(error) && error.kind === 'not_found') setWorkOrder({ status: 'missing', value: null, problem: null })
      else if (isApiError(error) && (error.kind === 'forbidden' || error.kind === 'step_up')) setWorkOrder({ status: 'forbidden', value: null, problem: null })
      else setWorkOrder({ status: 'error', value: null, problem: readProblem(error) })
    }
  }, [api, workOrderId, readable, loadParts])

  useEffect(() => {
    void load()
  }, [load])

  const reread = useCoalesced(() => void load(), 800)
  const live = useLive(
    (change) => {
      if (change.fields.workOrderId !== workOrderId) return
      if (/^production\.(cut_|hide_|bundle|replacement_|scrap_)|^workorder\./.test(change.type)) reread()
    },
    () => void load(),
    readable,
  )

  const cut = workOrder.value ? cutOf(workOrder.value, log.value, figures.value, allocated.value?.length ?? 0) : null

  // ---- Allocate hides (the same dialog as the Cutting page) ---------------------------------------------------------------------

  const readAvailability = useCallback(
    (material: { itemId: string; itemColourId: string | null }) => {
      if (!workOrder.value) return
      const siteId = workOrder.value.siteId
      setAlloc((current) => (current ? { ...current, material, availability: { value: null, problem: null } } : current))
      getAvailability(api, { siteId, itemId: material.itemId, itemColourId: material.itemColourId })
        .then((value) => setAlloc((current) => (current ? { ...current, availability: { value, problem: null } } : current)))
        .catch((error: unknown) => setAlloc((current) => (current ? { ...current, availability: { value: null, problem: readProblem(error) } } : current)))
    },
    [api, workOrder.value],
  )

  const openAlloc = useCallback(() => {
    if (!cut) return
    writeKey.current = newIdempotencyKey()
    const material = cut.materials[0] ?? null
    setAlloc({ cut, material: material ? { itemId: material.itemId, itemColourId: material.itemColourId } : null, availability: { value: null, problem: material ? null : 'problem.gone' }, busy: false, problem: null })
    if (material) readAvailability({ itemId: material.itemId, itemColourId: material.itemColourId })
  }, [cut, readAvailability])

  const reserve = useCallback(
    async (hideIds: string[]) => {
      if (!workOrder.value || hideIds.length === 0) return
      const key = writeKey.current ?? newIdempotencyKey()
      writeKey.current = key
      setAlloc((current) => (current ? { ...current, busy: true, problem: null } : current))
      try {
        await reserveHides(api, { siteId: workOrder.value.siteId, workOrderId, hideIds }, key)
        writeKey.current = null
        setAlloc(null)
        setNotice({ tone: 'success', words: phrase('notice.allocated', { count: hideIds.length, number: workOrder.value.number }) })
        if (can.stock) part(() => getAllocated(api, workOrderId), setAllocated)
      } catch (error) {
        writeKey.current = newIdempotencyKey()
        setAlloc((current) => (current ? { ...current, busy: false, problem: writeProblem(error) } : current))
        // The hides are read again, so the dialog shows what may be taken now.
        if (alloc?.material) readAvailability(alloc.material)
      }
    },
    [api, workOrder.value, workOrderId, can.stock, part, alloc?.material, readAvailability],
  )

  // ---- recut, reprint, void ---------------------------------------------------------------------------------------------------

  const write = useCallback(
    async (run: (key: string) => Promise<unknown>, done: CutRecordModel['notice']) => {
      const key = writeKey.current ?? newIdempotencyKey()
      writeKey.current = key
      setBusy(true)
      setProblem(null)
      try {
        await run(key)
        writeKey.current = null
        setDialog(null)
        setNotice(done)
        loadParts()
      } catch (error) {
        writeKey.current = newIdempotencyKey()
        setProblem(writeProblem(error))
      } finally {
        setBusy(false)
      }
    },
    [loadParts],
  )

  const model: CutRecordModel = {
    prefix,
    can,
    tab,
    timeZone: TIME_ZONE,
    workOrder,
    cut,
    log,
    figures,
    recuts,
    allocated: can.stock ? allocated : { value: [], problem: null },
    bundles,
    printers,
    live,
    dialog,
    alloc,
    busy,
    problem,
    notice,
  }

  return (
    <CutRecordView
      model={model}
      actions={{
        onRetry: () => void load(),
        onRetryPart: () => loadParts(),
        onAllocate: (id) => (id ? openAlloc() : setAlloc(null)),
        onMaterial: (material) => readAvailability(material),
        onReserve: (hideIds) => void reserve(hideIds),
        onDialog: (next) => {
          writeKey.current = next ? newIdempotencyKey() : null
          setProblem(null)
          setDialog(next)
        },
        onRecutDone: (replacementId, cutLogId) => {
          const recut = recuts.value?.find((row) => row.id === replacementId)
          if (!recut) return
          void write((key) => recutDone(api, replacementId, { version: recut.version, cutLogId }, key), { tone: 'success', words: phrase('notice.recutDone') })
        },
        onReprint: (bundleId, reason, printerId) => void write(() => reprintBundle(api, bundleId, { reason, printerId }), { tone: 'success', words: phrase('notice.reprinted') }),
        onVoid: (bundleId, reason) => void write((key) => voidBundle(api, bundleId, reason, key), { tone: 'success', words: phrase('notice.voided') }),
        onDismissNotice: () => setNotice(null),
        onTickets: () => router.push(`${pathname}?tab=tickets`),
      }}
    />
  )
}
