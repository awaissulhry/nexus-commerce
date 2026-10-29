'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { newIdempotencyKey } from '../../../lib/api/client'
import { isApiError } from '../../../lib/api/errors'
import { companyPrefix } from '../../../lib/session/session'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { RecordPanels } from '../../../record-panels/RecordPanels'
import { editDevice, listDevices, renewEnrolment, revokeDevice, type Device } from '../shared/api'
import { problemKey, problemNotice, type Notice } from '../shared/model'
import { useRecordTab, useThreadDock } from '../shared/record-hooks'
import { siteChoices, useEnrolWatch } from './DevicesPage'
import { DEVICE_TABS, type EnrolModel, type SiteChoice } from './model'
import { DeviceRecordView } from './view/DeviceRecordView'

/**
 * `/w/<company>/admin/devices/<id>` (SCR-013 Device record): the device from `GET /auth/floor/devices` (no read of one
 * device exists), its site and stations; renames it or moves it to a station (with the version read), makes a new
 * enrolment code (a lost or replaced tablet), revokes it.
 */
export function DeviceRecord({ deviceId }: { deviceId: string }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const held = useMemo(() => new Set(session.permissions), [session.permissions])
  const prefix = companyPrefix(session.company?.code ?? '')
  const tab = useRecordTab(DEVICE_TABS)
  const { dockOpen, toggleDock } = useThreadDock('Device')
  const can = { manage: held.has('devices.manage'), revoke: held.has('devices.revoke'), viewPrinters: held.has('print.view'), managePrinters: held.has('print.manage') }
  const [device, setDevice] = useState<Device | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [site, setSite] = useState<SiteChoice | null>(null)
  const [enrol, setEnrol] = useState<EnrolModel | null>(null)
  const [revoking, setRevoking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [dialogProblem, setDialogProblem] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [now, setNow] = useState(() => new Date().toISOString())

  const load = useCallback(async () => {
    setNow(new Date().toISOString())
    try {
      const found = (await listDevices(api)).find((item) => item.id === deviceId) ?? null
      setDevice(found)
      setProblem(found ? null : 'problem.notFound')
      if (found && held.has('companies.view') && held.has('sites.view')) {
        const choices = await siteChoices(api).catch(() => [])
        setSite(choices.find((item) => item.id === found.siteId) ?? null)
      }
    } catch (error) {
      setProblem(problemKey(error))
    }
  }, [api, deviceId, held])
  useEffect(() => {
    void load()
  }, [load])

  const onReady = useCallback(
    (next: Device) => {
      setEnrol({ step: 'ready', device: next })
      setDevice(next)
    },
    [],
  )
  const onExpired = useCallback(() => setEnrol((current) => (current?.step === 'scan' ? { ...current, expired: true } : current)), [])
  useEnrolWatch(api, enrol, onReady, onExpired)

  return (
    <DeviceRecordView
      model={{ prefix, tab, device, problem: device ? null : problem, site, can, enrol, revoking, busy, dialogProblem, notice, now, dockOpen }}
      panels={device ? <RecordPanels record={{ type: 'Device', id: device.id, companyId: site?.companyId ?? null, siteId: device.siteId }} title={device.name} /> : null}
      actions={{
        onSave: async (draft) => {
          if (!device) return false
          setBusy(true)
          setNotice(null)
          try {
            setDevice(await editDevice(api, device.id, { version: device.version, name: draft.name.trim(), stationId: draft.stationId || null }))
            setNotice({ key: 'device.done.saved', tone: 'success' })
            return true
          } catch (error) {
            setNotice(problemNotice(error))
            if (isApiError(error) && error.kind === 'conflict') void load()
            return false
          } finally {
            setBusy(false)
          }
        },
        onRenew: (current) => {
          setBusy(true)
          setDialogProblem(null)
          renewEnrolment(api, current.id, newIdempotencyKey())
            .then((answer) => {
              setDevice(answer.device)
              setEnrol({ step: 'scan', device: answer.device, enrolment: answer.enrolment })
            })
            .catch((error: unknown) => setNotice(problemNotice(error)))
            .finally(() => setBusy(false))
        },
        onEnrolClose: () => {
          setEnrol(null)
          void load()
        },
        onRevoke: (open) => {
          setDialogProblem(null)
          setRevoking(open)
        },
        onRevokeConfirm: async (current) => {
          setBusy(true)
          setDialogProblem(null)
          try {
            setDevice(await revokeDevice(api, current.id, { version: current.version }))
            setRevoking(false)
            setNotice({ key: 'devices.done.revoked', tone: 'success', params: { name: current.name } })
            return true
          } catch (error) {
            setDialogProblem(problemNotice(error).key)
            return false
          } finally {
            setBusy(false)
          }
        },
        onDock: toggleDock,
        onRetry: () => {
          setProblem(null)
          void load()
        },
        onDismissNotice: () => setNotice(null),
      }}
    />
  )
}
