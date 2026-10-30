'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { newIdempotencyKey } from '../../../lib/api/client'
import { companyPrefix } from '../../../lib/session/session'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { createDevice, createPrinter, failedJobs, getSite, listCompanies, listDevices, listPrinters, renewEnrolment, revokeDevice, updatePrinter, type Device, type Printer } from '../shared/api'
import { runBulk, type BulkResult } from '../shared/bulk'
import { bulkNotice } from '../shared/reach'
import { adminHref, failed, loaded, loading, problemKey, problemNotice, type Loaded, type Notice } from '../shared/model'
import { printerBody, type DevicesMode, type DeviceTile, type EnrolModel, type PrinterDialog, type SiteChoice } from './model'
import { fetchFloorVersion } from './version'
import { DevicesView } from './view/DevicesView'

/** How often the enrol dialog asks whether the tablet has used its code (no live event says so yet). */
export const ENROL_POLL_MS = 3000

/**
 * The sites with their stations, for the enrol and printer dialogs: the companies' active sites (`GET /org/companies`)
 * and each site's stations (`GET /org/sites/:id`). Shared by the Devices page and a device's record.
 */
export async function siteChoices(api: ReturnType<typeof useOfficeApi>): Promise<SiteChoice[]> {
  const companies = await listCompanies(api)
  const sites = companies.flatMap((company) => company.sites.filter((site) => site.status === 'ACTIVE'))
  return Promise.all(
    sites.map(async (site) => {
      const structure = await getSite(api, site.id).catch(() => null)
      return {
        id: site.id,
        name: site.name,
        companyId: site.companyId,
        stations: (structure?.stations ?? []).filter((station) => station.status === 'ACTIVE').map((station) => ({ id: station.id, code: station.code, name: station.name })),
      }
    }),
  )
}

/** While a code waits for its tablet, ask every few seconds; the device turns ACTIVE when the tablet trades it. */
export function useEnrolWatch(api: ReturnType<typeof useOfficeApi>, enrol: EnrolModel | null, onReady: (device: Device) => void, onExpired: () => void) {
  useEffect(() => {
    if (enrol?.step !== 'scan' || !enrol.enrolment || enrol.expired) return
    const { device, enrolment } = enrol
    const timer = window.setInterval(() => {
      if (Date.now() >= new Date(enrolment.expiresAt).getTime()) {
        onExpired()
        return
      }
      listDevices(api, device.siteId)
        .then((devices) => {
          const now = devices.find((item) => item.id === device.id)
          if (now?.status === 'ACTIVE') onReady(now)
        })
        .catch(() => undefined)
    }, ENROL_POLL_MS)
    return () => window.clearInterval(timer)
  }, [api, enrol, onReady, onExpired])
}

/**
 * `/w/<company>/admin/devices` (SCR-013): the devices (`GET /auth/floor/devices`), the printers (`GET /print/printers`,
 * archived too) and the printers with a failed job (`GET /print/jobs?status=FAILED`). Revoke, Pause and Resume over
 * the ticked rows are one call per row (`POST /auth/floor/devices/:id/revoke`, `PATCH /print/printers/:id` with each
 * one's version: the API has no bulk route). `?mode=printers` opens the printers; `?enrol=1` or `?enrol=<site id>` the enrol dialog; `?new=printer&site=<id>` the printer dialog.
 */
export function DevicesPage() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const params = useSearchParams()
  const held = useMemo(() => new Set(session.permissions), [session.permissions])
  const prefix = companyPrefix(session.company?.code ?? '')
  const can = { manage: held.has('devices.manage'), revoke: held.has('devices.revoke'), viewPrinters: held.has('print.view'), managePrinters: held.has('print.manage') }
  const [mode, setMode] = useState<DevicesMode>(params?.get('mode') === 'printers' && can.viewPrinters ? 'printers' : 'devices')
  const [devices, setDevices] = useState<Loaded<Device>>(loading())
  const [printers, setPrinters] = useState<Loaded<Printer>>(loading())
  const [failedPrinters, setFailedPrinters] = useState<number | null>(null)
  const [sites, setSites] = useState<SiteChoice[]>([])
  const [tile, setTile] = useState<DeviceTile | null>(null)
  const [query, setQuery] = useState('')
  const [pages, setPages] = useState(1)
  const [asOf, setAsOf] = useState<string | null>(null)
  const [now, setNow] = useState(() => new Date().toISOString())
  // B-W2a-42: the floor app version the server serves now (a tablet reporting another one is outdated).
  const [currentVersion, setCurrentVersion] = useState<string | null>(null)
  const asked = params?.get('enrol') ?? null
  const [enrol, setEnrol] = useState<EnrolModel | null>(asked ? { step: 'where', siteId: asked === '1' ? null : asked } : null)
  const [printer, setPrinter] = useState<PrinterDialog | null>(params?.get('new') === 'printer' ? { kind: 'new', siteId: params?.get('site') ?? null } : null)
  const [busy, setBusy] = useState(false)
  const [dialogProblem, setDialogProblem] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const enrolKey = useRef<string | null>(null)

  const load = useCallback(async () => {
    setNow(new Date().toISOString())
    await Promise.all([
      listDevices(api).then(
        (items) => setDevices(loaded(items)),
        (error: unknown) => setDevices(failed(problemKey(error))),
      ),
      held.has('print.view')
        ? listPrinters(api, undefined, true).then(
            (items) => setPrinters(loaded(items)),
            (error: unknown) => setPrinters(failed(problemKey(error))),
          )
        : Promise.resolve(),
      held.has('print.view') ? failedJobs(api).then((jobs) => setFailedPrinters(new Set(jobs.map((job) => job.printerId)).size), () => setFailedPrinters(null)) : Promise.resolve(),
      held.has('companies.view') && held.has('sites.view') ? siteChoices(api).then(setSites, () => undefined) : Promise.resolve(),
      fetchFloorVersion().then(setCurrentVersion),
    ])
    setAsOf(new Date().toISOString())
  }, [api, held])
  useEffect(() => {
    void load()
  }, [load])

  const onReady = useCallback(
    (device: Device) => {
      setEnrol({ step: 'ready', device })
      void load()
    },
    [load],
  )
  const onExpired = useCallback(() => setEnrol((current) => (current?.step === 'scan' ? { ...current, expired: true } : current)), [])
  useEnrolWatch(api, enrol, onReady, onExpired)

  const clearParams = () => {
    if (params?.get('enrol') || params?.get('new')) router.replace(`${adminHref(prefix, '/devices')}${mode === 'printers' ? '?mode=printers' : ''}`)
  }

  /** A bulk run: one call per row, one after the other (the API acts on one row per call); its ONE notice; read again. */
  const runRows = async <T,>(rows: readonly T[], call: (row: T) => Promise<unknown>, done: (result: BulkResult<T>) => Notice): Promise<boolean> => {
    setBusy(true)
    setDialogProblem(null)
    try {
      setNotice(done(await runBulk(rows, call)))
      return true
    } catch (error) {
      setDialogProblem(problemKey(error))
      return false
    } finally {
      setBusy(false)
      void load()
    }
  }

  return (
    <DevicesView
      model={{ prefix, mode, devices, printers, failedPrinters, sites, tile, query, pages, asOf, now, currentVersion, can, enrol, printer, busy, dialogProblem, notice }}
      actions={{
        onMode: (next) => {
          setMode(next)
          setPages(1)
          if (next === 'printers') setTile(null)
        },
        onTile: (next) => {
          setTile(next)
          setPages(1)
        },
        onQuery: (next) => {
          setQuery(next)
          setPages(1)
        },
        onMore: () => setPages((current) => current + 1),
        onOpen: (path) => router.push(path),
        onRetry: () => {
          setDevices(loading())
          setPrinters(loading())
          void load()
        },
        onEnrol: (open) => {
          setDialogProblem(null)
          enrolKey.current = null
          setEnrol(open ? { step: 'where' } : null)
          if (!open) clearParams()
        },
        onCreateDevice: async (draft) => {
          setBusy(true)
          setDialogProblem(null)
          enrolKey.current ??= newIdempotencyKey()
          try {
            const answer = await createDevice(api, { siteId: draft.siteId, name: draft.name.trim(), kind: draft.kind, ...(draft.stationId ? { stationId: draft.stationId } : {}) }, enrolKey.current)
            enrolKey.current = null
            setEnrol({ step: 'scan', device: answer.device, enrolment: answer.enrolment })
            void load()
            return true
          } catch (error) {
            setDialogProblem(problemKey(error))
            return false
          } finally {
            setBusy(false)
          }
        },
        onRenew: (device) => {
          setBusy(true)
          renewEnrolment(api, device.id, newIdempotencyKey())
            .then((answer) => setEnrol({ step: 'scan', device: answer.device, enrolment: answer.enrolment }))
            .catch((error: unknown) => setDialogProblem(problemKey(error)))
            .finally(() => setBusy(false))
        },
        onPrinter: (next) => {
          setDialogProblem(null)
          setPrinter(next)
          if (!next) clearParams()
        },
        onSavePrinter: async (draft, existing) => {
          setBusy(true)
          setDialogProblem(null)
          try {
            if (existing) await updatePrinter(api, existing.id, { version: existing.version, ...printerBody(draft), ...(draft.status !== existing.status ? { status: draft.status } : {}) })
            else await createPrinter(api, { siteId: draft.siteId, code: draft.code, kind: draft.kind, relay: 'FAKE', ...printerBody(draft) })
            setPrinter(null)
            setNotice({ key: existing ? 'printers.done.saved' : 'printers.done.added', tone: 'success' })
            clearParams()
            void load()
            return true
          } catch (error) {
            setDialogProblem(problemNotice(error).key)
            return false
          } finally {
            setBusy(false)
          }
        },
        onRevokeDevices: (rows, reason) =>
          runRows(
            rows,
            (device) => revokeDevice(api, device.id, { version: device.version, ...(reason ? { reason } : {}) }),
            (result) => bulkNotice(result, 'devices.bulk.done.revoke', (device) => device.name),
          ),
        onPrinterStatus: (action, rows) =>
          runRows(
            rows,
            (item) => updatePrinter(api, item.id, { version: item.version, status: action === 'pause' ? 'PAUSED' : 'ACTIVE' }),
            (result) => bulkNotice(result, action === 'pause' ? 'printers.bulk.done.pause' : 'printers.bulk.done.resume', (item) => item.name),
          ),
        onBulkClose: () => setDialogProblem(null),
        onDismissNotice: () => setNotice(null),
      }}
    />
  )
}
