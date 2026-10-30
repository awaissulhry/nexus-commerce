'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { isApiError } from '../../../../lib/api/errors'
import { useLocale } from '../../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { companyPrefix } from '../../../../lib/session/session'
import { findSuppliers, getMachine, listClasses, plantPlaces, retireMachine, updateMachine, type MachineClass, type MachineFields, type MachineRecord as MachineRecordValue, type PlantSite, type SupplierChoice } from '../../_shared/api'
import { useLive } from '../../_shared/hooks'
import { costMinorOf, costTextOf, fieldOf, plantCan, problemOf, readProblem, TIME_ZONE, yearOf } from '../../_shared/model'
import type { Loaded, Notice } from '../../_shared/parts'
import { MACHINE_TABS, type MachineDraft, type MachineRecordModel, type MachineTab } from '../view-model'
import { MachineRecordView } from './view/MachineRecordView'

/**
 * `/w/<company>/plant/machines/<id>` (SCR-150 record; `?tab=overview|history`): the machine read once and again on its live
 * changes (its status, its requests and jobs); the explicit edit of its facts (only what changed is sent, with the version
 * read); Retire with its reason.
 */
export function MachineRecord({ machineId }: { machineId: string }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const params = useSearchParams()
  const locale = useLocale()
  const prefix = companyPrefix(session.company?.code ?? '')
  const can = useMemo(() => plantCan(session.permissions), [session.permissions])
  const asked = params?.get('tab') ?? ''
  const tab: MachineTab = (MACHINE_TABS as readonly string[]).includes(asked) ? (asked as MachineTab) : 'overview'

  const [loaded, setLoaded] = useState<Loaded<MachineRecordValue>>({ status: 'loading' })
  const [asOf, setAsOf] = useState<string | null>(null)
  const load = useCallback(async () => {
    try {
      const value = await getMachine(api, machineId)
      setLoaded({ status: 'ready', value })
      setAsOf(new Date().toISOString())
    } catch (error) {
      setLoaded(isApiError(error) && error.kind === 'not_found' ? { status: 'notFound' } : isApiError(error) && error.kind === 'forbidden' ? { status: 'forbidden' } : { status: 'error', problem: readProblem(error) })
    }
  }, [api, machineId])
  useEffect(() => {
    if (!can.view) {
      setLoaded({ status: 'forbidden' })
      return
    }
    void load()
  }, [load, can.view])

  const [sites, setSites] = useState<PlantSite[]>([])
  const [classes, setClasses] = useState<MachineClass[]>([])
  useEffect(() => {
    if (!can.view) return
    plantPlaces(api)
      .then(setSites)
      .catch(() => setSites([]))
    listClasses(api)
      .then((found) => setClasses(found.filter((entry) => entry.active)))
      .catch(() => setClasses([]))
  }, [api, can.view])

  const value = loaded.status === 'ready' ? loaded.value : null
  const live = useLive(
    (change) => {
      if (value && change.fields.machineId === value.card.machine.id) void load()
    },
    () => void load(),
    can.view,
  )

  const [notice, setNotice] = useState<Notice | null>(null)
  const [edit, setEdit] = useState<MachineDraft | null>(null)
  const [suppliers, setSuppliers] = useState<SupplierChoice[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [field, setField] = useState<string | null>(null)
  const [retire, setRetire] = useState<MachineRecordModel['retire']>(null)

  const startEdit = useCallback(() => {
    if (!value) return
    const machine = value.card.machine
    setEdit({
      siteId: machine.siteId,
      assetNumber: machine.assetNumber,
      classId: machine.class.id,
      make: machine.make ?? '',
      modelName: machine.modelName ?? '',
      serialNumber: machine.serialNumber ?? '',
      year: machine.year !== null ? String(machine.year) : '',
      stationId: machine.station?.id ?? null,
      workCentreId: machine.workCentre?.id ?? null,
      supplier: machine.supplier ? { id: machine.supplier.id, code: machine.supplier.code, legalName: machine.supplier.name } : null,
      cost: costTextOf(machine.purchaseCost, locale),
      note: machine.note ?? '',
    })
    setField(null)
  }, [value, locale])

  const apply = useCallback(async () => {
    if (!value || !edit || busy) return
    const machine = value.card.machine
    const change: MachineFields & { version: number } = { version: machine.version }
    const text = (next: string, now: string | null) => (next.trim() === (now ?? '') ? undefined : next.trim() || null)
    if (edit.classId && edit.classId !== machine.class.id) change.classId = edit.classId
    const make = text(edit.make, machine.make)
    if (make !== undefined) change.make = make
    const modelName = text(edit.modelName, machine.modelName)
    if (modelName !== undefined) change.modelName = modelName
    const serial = text(edit.serialNumber, machine.serialNumber)
    if (serial !== undefined) change.serialNumber = serial
    const year = yearOf(edit.year)
    if (year !== undefined && year !== machine.year) change.year = year
    if (edit.stationId !== (machine.station?.id ?? null)) change.stationId = edit.stationId
    if (edit.workCentreId !== (machine.workCentre?.id ?? null)) change.workCentreId = edit.workCentreId
    if (can.parties && (edit.supplier?.id ?? null) !== (machine.supplier?.id ?? null)) change.supplierId = edit.supplier?.id ?? null
    const cost = costMinorOf(edit.cost)
    if (can.cost && cost !== undefined && cost !== (machine.purchaseCost ?? null)) change.purchaseCost = cost
    const note = text(edit.note, machine.note)
    if (note !== undefined) change.note = note
    if (Object.keys(change).length === 1) {
      setEdit(null)
      return
    }
    setBusy(true)
    try {
      const saved = await updateMachine(api, machine.id, change)
      setLoaded({ status: 'ready', value: { ...value, card: { ...value.card, machine: saved } } })
      setEdit(null)
      setNotice({ tone: 'success', words: { key: 'done.machineSaved', params: { machine: saved.assetNumber } } })
    } catch (error) {
      setField(fieldOf(error))
      setNotice({ tone: 'danger', words: { key: 'cell.refusedMachine', params: { machine: machine.assetNumber } }, detail: problemOf(error) })
    } finally {
      setBusy(false)
    }
  }, [api, value, edit, busy, can.parties, can.cost])

  const submitRetire = useCallback(async () => {
    if (!value || !retire || retire.busy) return
    setRetire({ ...retire, busy: true, problem: null })
    try {
      const machine = await retireMachine(api, value.card.machine.id, { version: value.card.machine.version, reason: retire.reason.trim() })
      setRetire(null)
      setNotice({ tone: 'success', words: { key: 'done.retired', params: { count: 1 } } })
      setLoaded({ status: 'ready', value: { ...value, card: { ...value.card, machine } } })
      void load()
    } catch (error) {
      setRetire((current) => (current ? { ...current, busy: false, problem: problemOf(error) } : current))
    }
  }, [api, value, retire, load])

  const model: MachineRecordModel = { prefix, can, tab, loaded, timeZone: TIME_ZONE, live, asOf, sites, classes, edit, suppliers, busy, field, retire, notice }

  return (
    <MachineRecordView
      model={model}
      actions={{
        onRetry: () => void load(),
        onEdit: startEdit,
        onDraft: (patch) => {
          setEdit((current) => (current ? { ...current, ...patch } : current))
          setField(null)
        },
        onFindSupplier: (text) => {
          if (!can.parties || text.trim().length < 2) {
            setSuppliers(null)
            return
          }
          findSuppliers(api, text)
            .then(setSuppliers)
            .catch(() => setSuppliers([]))
        },
        onEditCancel: () => setEdit(null),
        onEditApply: () => void apply(),
        onRetire: () => setRetire({ reason: '', busy: false, problem: null }),
        onRetireReason: (reason) => setRetire((current) => (current ? { ...current, reason } : current)),
        onRetireClose: () => setRetire(null),
        onRetireSubmit: () => void submitRetire(),
        onDismissNotice: () => setNotice(null),
      }}
    />
  )
}
