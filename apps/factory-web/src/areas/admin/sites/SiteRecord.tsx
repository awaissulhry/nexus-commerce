'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { isApiError } from '../../../lib/api/errors'
import { companyPrefix } from '../../../lib/session/session'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { RecordPanels } from '../../../record-panels/RecordPanels'
import {
  createLine,
  createStation,
  createWorkCentre,
  editLine,
  editSite,
  editStation,
  editWorkCentre,
  getFloorSettings,
  getSite,
  listDevices,
  listPrinters,
  putFloorSettings,
  type Device,
  type FloorSettings,
  type Printer,
  type SiteStructure,
} from '../shared/api'
import { failed, loaded, loading, problemKey, problemNotice, type Loaded, type Notice } from '../shared/model'
import { useRecordTab, useThreadDock } from '../shared/record-hooks'
import { floorBody, SITE_TABS, type FloorDraft, type PartDraft, type SiteDialog } from './model'
import { SiteRecordView } from './view/SiteRecordView'

/**
 * `/w/<company>/admin/companies/<company id>/sites/<id>` (SCR-009): reads the site's structure (`GET /org/sites/:id`),
 * its floor times (`GET /auth/floor/sites/:id/settings`, devices.view), its devices and printers; adds and changes
 * lines, work centres and stations (each with the version read), saves the floor times, archives what nothing uses.
 */
export function SiteRecord({ siteId }: { siteId: string }) {
  const api = useOfficeApi()
  const router = useRouter()
  const session = useOfficeSession()
  const held = useMemo(() => new Set(session.permissions), [session.permissions])
  const prefix = companyPrefix(session.company?.code ?? '')
  const tab = useRecordTab(SITE_TABS)
  const { dockOpen, toggleDock } = useThreadDock('Site')
  const [structure, setStructure] = useState<SiteStructure | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [floor, setFloor] = useState<{ settings: FloorSettings | null; problem?: string | null }>({ settings: null })
  const [devices, setDevices] = useState<Loaded<Device>>(loading())
  const [printers, setPrinters] = useState<Loaded<Printer>>(loading())
  const [showArchived, setShowArchived] = useState(false)
  const [busy, setBusy] = useState(false)
  const [dialogProblem, setDialogProblem] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [dialog, setDialog] = useState<SiteDialog | null>(null)
  const can = { manage: held.has('sites.manage'), viewDevices: held.has('devices.view'), manageDevices: held.has('devices.manage'), viewPrinters: held.has('print.view') }

  const load = useCallback(async () => {
    try {
      setStructure(await getSite(api, siteId))
      setProblem(null)
    } catch (error) {
      setProblem(problemKey(error))
    }
  }, [api, siteId])
  const loadFloor = useCallback(async () => {
    if (!held.has('devices.view')) return
    try {
      setFloor({ settings: await getFloorSettings(api, siteId) })
    } catch (error) {
      setFloor({ settings: null, problem: problemKey(error) })
    }
    try {
      setDevices(loaded(await listDevices(api, siteId)))
    } catch (error) {
      setDevices(failed(problemKey(error)))
    }
    if (held.has('print.view')) {
      try {
        setPrinters(loaded(await listPrinters(api, siteId)))
      } catch (error) {
        setPrinters(failed(problemKey(error)))
      }
    }
  }, [api, held, siteId])
  useEffect(() => {
    void load()
    void loadFloor()
  }, [load, loadFloor])

  /** One change: on success the structure is read again and the dialog closes; a 409 reads it again too. */
  const change = async (work: () => Promise<unknown>, done: string): Promise<boolean> => {
    setBusy(true)
    setDialogProblem(null)
    try {
      await work()
      setDialog(null)
      setNotice({ key: done, tone: 'success' })
      await load()
      return true
    } catch (error) {
      setDialogProblem(problemNotice(error).key)
      if (isApiError(error) && error.kind === 'conflict') void load()
      return false
    } finally {
      setBusy(false)
    }
  }
  const versionOf = (target: 'line' | 'station' | 'centre', id: string) => {
    const rows: ReadonlyArray<{ id: string; version: number }> = !structure ? [] : target === 'line' ? structure.lines : target === 'centre' ? structure.workCentres : structure.stations
    return rows.find((row) => row.id === id)?.version ?? 1
  }

  return (
    <SiteRecordView
      model={{ prefix, tab, structure, problem, can, floor, devices, printers, showArchived, dialog, busy, dialogProblem, notice, dockOpen }}
      panels={structure ? <RecordPanels record={{ type: 'Site', id: structure.site.id, companyId: structure.site.companyId, siteId: structure.site.id }} title={structure.site.name} /> : null}
      actions={{
        onDialog: (next) => {
          setDialog(next)
          setDialogProblem(null)
        },
        onShowArchived: setShowArchived,
        onOpen: (path) => router.push(path),
        onCreate: (kind: 'line' | 'station' | 'centre', draft: PartDraft) =>
          change(
            () =>
              kind === 'line'
                ? createLine(api, siteId, { code: draft.code, name: draft.name.trim() })
                : kind === 'centre'
                  ? createWorkCentre(api, siteId, { code: draft.code, name: draft.name.trim(), kind: draft.kind })
                  : createStation(api, siteId, { code: draft.code, name: draft.name.trim(), workCentreId: draft.workCentreId, lineId: draft.lineId || null }),
            `site.done.${kind}`,
          ),
        onRename: (target, id, name) =>
          change(
            () =>
              target === 'line'
                ? editLine(api, id, { version: versionOf(target, id), name })
                : target === 'centre'
                  ? editWorkCentre(api, id, { version: versionOf(target, id), name })
                  : editStation(api, id, { version: versionOf(target, id), name }),
            'site.done.renamed',
          ),
        onMove: (stationId, lineId) => change(() => editStation(api, stationId, { version: versionOf('station', stationId), lineId }), 'site.done.moved'),
        onArchive: (target, id) =>
          change(
            () =>
              target === 'site'
                ? editSite(api, id, { version: structure?.site.version ?? 1, status: 'ARCHIVED' })
                : target === 'line'
                  ? editLine(api, id, { version: versionOf(target, id), status: 'ARCHIVED' })
                  : target === 'centre'
                    ? editWorkCentre(api, id, { version: versionOf(target, id), status: 'ARCHIVED' })
                    : editStation(api, id, { version: versionOf(target, id), status: 'ARCHIVED' }),
            'site.done.archived',
          ),
        onSaveFloor: async (draft: FloorDraft) => {
          setBusy(true)
          setNotice(null)
          try {
            const settings = await putFloorSettings(api, siteId, floorBody(draft, floor.settings?.version))
            setFloor({ settings })
            setNotice({ key: 'site.done.floor', tone: 'success' })
            return true
          } catch (error) {
            setNotice(problemNotice(error))
            if (isApiError(error) && error.kind === 'conflict') void loadFloor()
            return false
          } finally {
            setBusy(false)
          }
        },
        onDock: toggleDock,
        onRetry: () => {
          setProblem(null)
          setStructure(null)
          void load()
          void loadFloor()
        },
        onDismissNotice: () => setNotice(null),
      }}
    />
  )
}
