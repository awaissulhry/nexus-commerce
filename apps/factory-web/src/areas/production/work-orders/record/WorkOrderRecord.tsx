'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { isApiError } from '../../../../lib/api/errors'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { WithMessages } from '../../../../record-panels/i18n'
import { RecordPanels } from '../../../../record-panels/RecordPanels'
import {
  cancelWorkOrder,
  correctCut,
  getBundles,
  getBundleScans,
  getCutLog,
  getFinalState,
  getPickList,
  getReleaseCheck,
  getTicketPrinters,
  getWorkOrder,
  getWorkOrderWip,
  moveWorkOrder,
  releaseWorkOrder,
  reprintBundle,
  setCells,
  updateWorkOrder,
  type BundleScan,
  type CutLog,
  type FinalState,
  type PickList,
  type ReleaseCheck,
  type TicketPrinters,
  type WorkOrder,
  type WorkOrderBundles,
  type WorkOrderWip,
} from '../../_shared/api'
import { useCoalesced, useLive, useThreadDock } from '../../_shared/hooks'
import { abilitiesOf, cellsBody, liveTouches, readProblem, releaseRefusalCodes, tabOf, writeProblem, type SizeLayer } from '../../_shared/model'
import { PART_LOADING, type Loaded, type Part, type RecordDialog, type ReprintRun, type WorkOrderRecordModel } from './record-model'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { useStepUp, isStepUpCancelled } from '../../../quality/_shared/hooks'
import { useLabourCost } from '../labour/use-labour'
import { getAvailability, getFinished, getHold, getReadiness, getScrap, getYield, holdReasons, listHolds, placeHold, releaseHold, reportFinished, reserveHides, splitBundle } from '../daily/api'
import { beforeRelease, DAILY_NAMESPACE, dailyCan, dailyProblem, dailyReadProblem, FINISHABLE, LOADING, NO_DAILY, READINESS_STATUSES, type DailyDialog, type DailyModel } from '../daily/model'
import { WorkOrderRecordView } from './view/WorkOrderRecordView'

/**
 * `/w/<company>/production/work-orders/<id>` (SCR-070 … SCR-072): loads the work order (workorders.view; the API checks
 * its company and site), and per state the parts its tabs show — a draft's release check; from the release on its
 * WIP, cut log and bundles, the pick list (inventory.issue) and the quality state (quality.inspections.view) — and does
 * what the view asks, one write at a time, each with the work order's version as read (a 409 reads it again and says
 * so). Live: its workorder.* and production.* events read the parts again; with unsaved work the page says it changed.
 */
export function WorkOrderRecord({ workOrderId }: { workOrderId: string }) {
  return (
    <WithMessages namespaces={['production', DAILY_NAMESPACE, 'lists', 'records']}>
      <RecordContainer workOrderId={workOrderId} />
    </WithMessages>
  )
}

const part = <T,>(value: T): Part<T> => ({ value, problem: null })

function RecordContainer({ workOrderId }: { workOrderId: string }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const tab = tabOf(params?.get('tab'))
  const atParam = params?.get('at')
  const waitingAt = atParam && /^\d+$/.test(atParam) ? Number(atParam) : null
  const prefix = pathname.replace(/\/production\/work-orders\/[^/]+\/?$/, '')
  const can = useMemo(() => abilitiesOf(session.permissions), [session.permissions])

  const [workOrder, setWorkOrder] = useState<Loaded<WorkOrder>>({ status: 'loading' })
  const current = useRef<WorkOrder | null>(null)
  const [check, setCheck] = useState<Part<ReleaseCheck>>(PART_LOADING)
  const [wip, setWip] = useState<Part<WorkOrderWip>>(PART_LOADING)
  const [cutLog, setCutLog] = useState<Part<CutLog>>(PART_LOADING)
  const [bundles, setBundles] = useState<Part<WorkOrderBundles>>(PART_LOADING)
  const [pick, setPick] = useState<Part<PickList> | null>(can.pick ? PART_LOADING : null)
  const [quality, setQuality] = useState<Part<FinalState> | null>(can.quality ? PART_LOADING : null)
  const [printers, setPrinters] = useState<Part<TicketPrinters> | null>(can.bundles ? PART_LOADING : null)
  const [dialog, setDialog] = useState<RecordDialog | null>(null)
  const [reprint, setReprint] = useState<ReprintRun | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<WorkOrderRecordModel['notice']>(null)
  const [dialogProblem, setDialogProblem] = useState<WorkOrderRecordModel['dialogProblem']>(null)
  const dialogRef = useRef<RecordDialog | null>(null)
  dialogRef.current = dialog
  const [changed, setChanged] = useState<{ at: string } | null>(null)
  const [sizeLayer, setSizeLayer] = useState<SizeLayer>('finished')
  const [bundleOpen, setBundleOpen] = useState<{ bundleId: string; scans: Part<BundleScan[]> } | null>(null)
  const [cutOpen, setCutOpen] = useState<string | null>(null)
  const dirty = useRef(new Set<'details' | 'sizes'>())
  const { dockOpen, toggleDock } = useThreadDock()

  // B-W2a-46: the work order every day (holds, finished to stock, yield, scrap and rework, readiness, reserve, split).
  const dcan = useMemo(() => dailyCan(session.permissions), [session.permissions])
  const [daily, setDaily] = useState<DailyModel>(() => NO_DAILY(dcan))
  const patchDailyNow = useCallback((patch: Partial<DailyModel>) => setDaily((current) => ({ ...current, ...patch })), [])
  const patchDaily = patchDailyNow
  const { stepUp, guard, submitStepUp, cancelStepUp } = useStepUp(api)
  const dailyRef = useRef(daily)
  dailyRef.current = daily

  const setValue = useCallback((next: WorkOrder) => {
    current.current = next
    setWorkOrder({ status: 'ready', value: next })
  }, [])

  // Each read of the parts has a turn: an answer of an older read (a slow one before a write) never replaces a newer one.
  const dailyTurn = useRef(0)
  const loadDaily = useCallback(
    (wo: WorkOrder) => {
      const turn = ++dailyTurn.current
      const patchDaily = (patch: Partial<DailyModel>) => {
        if (turn === dailyTurn.current) patchDailyNow(patch)
      }
      const fail = (key: keyof DailyModel) => (error: unknown) => patchDaily({ [key]: { value: null, problem: dailyReadProblem(error) } } as Partial<DailyModel>)
      if (dcan.holdsView) {
        listHolds(api, { subjectType: 'WorkOrder', subjectId: wo.id, status: 'ALL' })
          .then((value) => patchDaily({ holds: { value, problem: null } }))
          .catch(fail('holds'))
        if (!beforeRelease(wo))
          listHolds(api, { subjectType: 'Bundle', siteId: wo.siteId })
            .then((value) => patchDaily({ bundleHolds: value }))
            .catch(() => patchDaily({ bundleHolds: null }))
      }
      if ((dcan.holdsView || dcan.holdsPlace) && !dailyRef.current.reasons)
        holdReasons(api)
          .then((value) => patchDaily({ reasons: value }))
          .catch(() => undefined)
      if (beforeRelease(wo)) return
      if (READINESS_STATUSES.includes(wo.status) && wo.kind !== 'REPAIR') {
        patchDaily({ readiness: LOADING })
        getReadiness(api, [wo.id])
          .then(([row]) => patchDaily({ readiness: { value: row ?? null, problem: null } }))
          .catch(fail('readiness'))
      }
      if (FINISHABLE.includes(wo.status) || wo.status === 'ON_HOLD') {
        patchDaily({ finished: dailyRef.current.finished?.value ? dailyRef.current.finished : LOADING })
        getFinished(api, wo.id)
          .then((value) => patchDaily({ finished: { value, problem: null } }))
          .catch(fail('finished'))
      }
      patchDaily({ yield: dailyRef.current.yield?.value ? dailyRef.current.yield : LOADING })
      getYield(api, wo.id)
        .then((value) => patchDaily({ yield: { value, problem: null } }))
        .catch(fail('yield'))
      if (dcan.scrapView)
        getScrap(api, wo.id)
          .then((value) => patchDaily({ scrap: { value, problem: null } }))
          .catch(fail('scrap'))
    },
    [api, dcan, patchDailyNow],
  )

  const loadParts = useCallback(
    async (wo: WorkOrder) => {
      loadDaily(wo)
      if (beforeRelease(wo)) {
        getReleaseCheck(api, wo.id)
          .then((value) => setCheck(part(value)))
          .catch((error: unknown) => setCheck({ value: null, problem: readProblem(error) }))
        return
      }
      getWorkOrderWip(api, wo.id)
        .then((value) => setWip(part(value)))
        .catch((error: unknown) => setWip({ value: null, problem: readProblem(error) }))
      getCutLog(api, wo.id)
        .then((value) => setCutLog(part(value)))
        .catch((error: unknown) => setCutLog({ value: null, problem: readProblem(error) }))
      getBundles(api, wo.id)
        .then((value) => setBundles(part(value)))
        .catch((error: unknown) => setBundles({ value: null, problem: readProblem(error) }))
      if (can.pick)
        getPickList(api, wo.id)
          .then((value) => setPick(part(value)))
          .catch((error: unknown) => setPick({ value: null, problem: readProblem(error) }))
      if (can.quality)
        getFinalState(api, wo.id)
          .then((value) => setQuality(part(value)))
          .catch((error: unknown) => setQuality({ value: null, problem: readProblem(error) }))
    },
    [api, can.pick, can.quality, loadDaily],
  )

  const load = useCallback(async () => {
    try {
      const next = await getWorkOrder(api, workOrderId)
      setValue(next)
      setChanged(null)
      void loadParts(next)
    } catch (error) {
      if (isApiError(error) && error.kind === 'not_found') setWorkOrder({ status: 'not_found' })
      else if (isApiError(error) && error.kind === 'forbidden') setWorkOrder({ status: 'forbidden' })
      else setWorkOrder({ status: 'error', problem: readProblem(error) })
    }
  }, [api, workOrderId, setValue, loadParts])

  useEffect(() => {
    void load()
  }, [load])

  // The site's label printers, once a reprint is asked (production.bundles).
  useEffect(() => {
    if (dialog?.kind !== 'reprint' || !can.bundles || printers?.value) return
    getTicketPrinters(api, workOrderId)
      .then((value) => setPrinters(part(value)))
      .catch((error: unknown) => setPrinters({ value: null, problem: readProblem(error) }))
  }, [dialog, can.bundles, printers?.value, api, workOrderId])

  // B-W2a-46: what a dialog reads when it opens (the hides of a material; the hold and its release checks).
  const dialogKey = daily.dialog ? JSON.stringify(daily.dialog) : ''
  useEffect(() => {
    const open = dailyRef.current.dialog
    const wo = current.current
    if (!open || !wo) return
    if (open.kind === 'reserve') {
      patchDaily({ availability: LOADING })
      getAvailability(api, { siteId: wo.siteId, itemId: open.itemId, itemColourId: open.itemColourId })
        .then((value) => patchDaily({ availability: { value, problem: null } }))
        .catch((error: unknown) => patchDaily({ availability: { value: null, problem: dailyReadProblem(error) } }))
    }
    if (open.kind === 'releaseHold') {
      patchDaily({ holdRecord: LOADING })
      getHold(api, open.holdId)
        .then((value) => patchDaily({ holdRecord: { value, problem: null } }))
        .catch((error: unknown) => patchDaily({ holdRecord: { value: null, problem: dailyReadProblem(error) } }))
    }
  }, [dialogKey, api, patchDaily])

  /** One W2a write; success closes its dialog, says so and reads the work order again. */
  const dailyWrite = useCallback(
    async (run: () => Promise<unknown>, success: { key: string; params?: Record<string, string | number> }) => {
      if (dailyRef.current.busy) return
      patchDaily({ busy: true, problem: null })
      try {
        await run()
        patchDaily({ busy: false, dialog: null, problem: null })
        setNotice({ tone: 'success', words: { key: `${DAILY_NAMESPACE}:${success.key}`, ...(success.params ? { params: success.params } : {}) } })
        await load()
      } catch (error) {
        if (isStepUpCancelled(error)) patchDaily({ busy: false })
        else patchDaily({ busy: false, problem: dailyProblem(error) })
      }
    },
    [patchDaily, load],
  )

  // Live: this work order's events read it again (one read for a burst of scans); unsaved work → "changed · Reload".
  const reread = useCoalesced(() => void load(), 700)
  const live = useLive(
    (change) => {
      if (!liveTouches(change, workOrderId)) return
      if (dirty.current.size > 0 || (dialog && dialog.kind !== 'reprint')) setChanged({ at: new Date().toISOString() })
      else reread()
    },
    () => void load(),
  )

  /** One write; the work order it answers (when it answers one) replaces the page's, then the parts are read again. */
  const write = useCallback(
    async (run: () => Promise<WorkOrder | null>, area: 'workOrder' | 'cut' | 'bundle', success: string | null) => {
      if (busy) return
      setBusy(true)
      setNotice(null)
      setDialogProblem(null)
      try {
        const next = await run()
        if (next) setValue(next)
        setDialog(null)
        if (success) setNotice({ tone: 'success', words: { key: success } })
        await load()
      } catch (error) {
        const words = writeProblem(error, area)
        if (dialogRef.current) setDialogProblem(words)
        else setNotice({ tone: 'danger', words })
        if (isApiError(error) && error.kind === 'conflict' && area === 'workOrder') void load()
      } finally {
        setBusy(false)
      }
    },
    [busy, load, setValue],
  )

  const version = () => current.current?.version ?? 1

  // B-W2a-72: the Labour & cost tab reads the work order's cost while it is open.
  const labour = useLabourCost(api, workOrderId, tab === 'labour', session.permissions, workOrder.status === 'ready' ? { status: workOrder.value.status, version: workOrder.value.version } : null)

  const model: WorkOrderRecordModel = {
    prefix,
    can,
    tab,
    workOrder,
    check,
    wip,
    cutLog,
    bundles,
    pick,
    quality,
    printers,
    live,
    dockOpen,
    changed,
    notice,
    busy,
    dialog,
    dialogProblem,
    reprint,
    sizeLayer,
    waitingAt,
    bundleOpen,
    cutOpen,
    daily: { ...daily, can: dcan, stepUp },
    labour: labour.model,
  }

  const value = workOrder.status === 'ready' ? workOrder.value : null

  return (
    <WorkOrderRecordView
      model={model}
      panels={value ? <RecordPanels record={{ type: 'WorkOrder', id: value.id, companyId: value.companyId, siteId: value.siteId }} title={`${value.number} · ${value.style.code}`} /> : null}
      actions={{
        onRetry: () => void load(),
        onRetryLabour: labour.retry,
        onRetryPart: () => value && void loadParts(value),
        onReload: () => void load(),
        onDock: toggleDock,
        onDismissNotice: () => setNotice(null),
        onDialog: (next) => {
          setDialog(next)
          setDialogProblem(null)
          if (next?.kind === 'reprint') setReprint(null)
        },
        onRelease: (overrideReason) =>
          void write(
            async () => {
              try {
                const released = await releaseWorkOrder(api, workOrderId, { version: version(), ...(overrideReason ? { materialOverride: { reason: overrideReason } } : {}) })
                setNotice({ tone: 'success', words: { key: 'notice.released', params: { batch: released.batchNumber ?? '—' } } })
                return released
              } catch (error) {
                // The release's own check found something since the page read it: the page shows the check again.
                const codes = releaseRefusalCodes(error)
                if (codes.length === 0) throw error
                setNotice({ tone: 'danger', words: { key: 'release.refused', params: { count: codes.length } } })
                return null
              }
            },
            'workOrder',
            null,
          ),
        onMove: (move) => void write(() => moveWorkOrder(api, workOrderId, move, version()), 'workOrder', `notice.${move}`),
        onCancel: (reason) => void write(() => cancelWorkOrder(api, workOrderId, version(), reason), 'workOrder', 'notice.cancelled'),
        onSaveDetails: (details) => {
          dirty.current.delete('details')
          void write(() => updateWorkOrder(api, workOrderId, { version: version(), dueDate: details.dueDate, priority: details.priority }), 'workOrder', 'notice.saved')
        },
        onSaveSizes: (grid) => {
          dirty.current.delete('sizes')
          const wo = current.current
          if (!wo) return
          void write(() => setCells(api, workOrderId, { version: version(), cells: cellsBody(wo, grid) }), 'workOrder', 'notice.sizesSaved')
        },
        onDirty: (which, on) => {
          if (on) dirty.current.add(which)
          else dirty.current.delete(which)
        },
        onSizeLayer: setSizeLayer,
        onCorrect: (entryId, reason) =>
          void write(
            async () => {
              await correctCut(api, entryId, reason)
              setCutOpen(null)
              return null
            },
            'cut',
            'notice.corrected',
          ),
        onReprint: (bundleIds, reason, printerId) => {
          void (async () => {
            const results: ReprintRun['results'] = {}
            setReprint({ running: true, done: false, results })
            for (const bundleId of bundleIds) {
              try {
                const answer = await reprintBundle(api, bundleId, { reason, printerId })
                results[bundleId] = { state: 'done', code: answer.bundle.code }
              } catch (error) {
                results[bundleId] = { state: 'failed', words: writeProblem(error, 'bundle') }
              }
              setReprint({ running: true, done: false, results: { ...results } })
            }
            setReprint({ running: false, done: true, results: { ...results } })
            const wo = current.current
            if (wo) void loadParts(wo)
          })()
        },
        onCloseReprint: () => {
          setDialog(null)
          setReprint(null)
        },
        onOpenBundle: (bundleId) => {
          if (!bundleId) {
            setBundleOpen(null)
            return
          }
          setBundleOpen({ bundleId, scans: PART_LOADING })
          getBundleScans(api, workOrderId, bundleId)
            .then((scans) => setBundleOpen((open) => (open && open.bundleId === bundleId ? { bundleId, scans: part(scans) } : open)))
            .catch((error: unknown) => setBundleOpen((open) => (open && open.bundleId === bundleId ? { bundleId, scans: { value: null, problem: readProblem(error) } } : open)))
        },
        onOpenCut: setCutOpen,
        daily: {
          onDialog: (next: DailyDialog | null) => patchDaily({ dialog: next, problem: null }),
          onRetry: () => {
            const wo = current.current
            if (wo) loadDaily(wo)
          },
          onPlaceHold: (input) =>
            void dailyWrite(() => placeHold(api, input), { key: input.workOrderIds.length === 1 ? 'notice.held' : 'notice.heldMany', params: { count: input.workOrderIds.length } }),
          onReleaseHold: (input) => {
            const key = newIdempotencyKey()
            void dailyWrite(() => guard('releaseHold.stepUpSentence', () => releaseHold(api, input.holdId, { version: input.version, note: input.note, notMakerStatement: input.notMakerStatement }, key)), { key: 'notice.holdReleased' })
          },
          onReport: (input) => {
            const key = newIdempotencyKey()
            const pieces = input.cells.reduce((sum, cell) => sum + cell.quantity, 0)
            void dailyWrite(() => reportFinished(api, workOrderId, input, key), { key: 'notice.finished', params: { count: pieces } })
          },
          onReserve: (hideIds) => {
            const wo = current.current
            if (!wo) return
            const key = newIdempotencyKey()
            void dailyWrite(() => reserveHides(api, { siteId: wo.siteId, workOrderId: wo.id, hideIds }, key), { key: 'notice.reserved', params: { count: hideIds.length } })
          },
          onSplit: (input) => {
            const key = newIdempotencyKey()
            void dailyWrite(() => splitBundle(api, input.bundleId, { quantity: input.quantity, reason: input.reason, note: input.note, printerId: null }, key), { key: 'notice.split', params: { count: input.quantity } })
          },
          onStepUp: (code) => void submitStepUp(code),
          onCancelStepUp: cancelStepUp,
        },
        onWaitingAt: (seq) => {
          const query = new URLSearchParams(params?.toString() ?? '')
          query.set('tab', 'bundles')
          if (seq === null) query.delete('at')
          else query.set('at', String(seq))
          router.replace(`${pathname}?${query.toString()}`)
        },
      }}
    />
  )
}
