'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { WithMessages } from '../../../record-panels/i18n'
import { useCoalesced, useLive } from '../../_shared/buying/hooks'
import { addGate, editGate, getChoices, getMilestones, passGates, removeGate, startBefore, type Gate, type Milestones } from './api'
import { bodyOf, canOf, controlsOf, draftOfGate, emptyDraft, kindsLeft, queryOf, readProblemOf, reasonHeld, refusalOf, type Controls } from './model'
import type { Loaded, MilestonesDialog, MilestonesModel, Notice } from './view-model'
import { MILESTONES_NAMESPACES, MilestonesView, useMilestonesWords } from './view/MilestonesView'

/**
 * `/w/<company>/planning/milestones` (SCR-253; Planning › Dates › Time & action, planning.view): ONE read of the company's open
 * orders (GET /planning/milestones) — the tiles, every order's gates and milestones —, the view in the address (`?view=`), the
 * tiles as saved filters (`?tile=`), the search (`?q=`), a milestone's dialog (`?open=`), Add a gate (`?add=1` or the order's
 * id). Writes: add, change, remove, mark done (one or the ticked ones), start before the gate; each answers, then the page
 * reads again. Live: `order_gate.changed` (another planner, a sample decided, a lot released), `sample_round.decided`,
 * `lot.released`, `planning.schedule_changed`, `workorder.*`, `shipment.*` read again (at most every second).
 */
export function MilestonesPage() {
  return (
    <WithMessages namespaces={[...MILESTONES_NAMESPACES]}>
      <MilestonesContainer />
    </WithMessages>
  )
}

function MilestonesContainer() {
  const { t } = useMilestonesWords()
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname() ?? ''
  const params = useSearchParams()
  const query = params?.toString() ?? ''
  const controls = useMemo(() => controlsOf(new URLSearchParams(query)), [query])
  const prefix = pathname.replace(/\/planning\/milestones\/?$/, '')
  const can = useMemo(() => canOf(session.permissions), [session.permissions])
  const companyId = session.company?.id ?? null

  const [world, setWorld] = useState<Loaded<Milestones>>({ status: 'loading' })
  const [notice, setNotice] = useState<Notice | null>(null)
  const [dialog, setDialog] = useState<MilestonesDialog | null>(null)
  const controlsRef = useRef(controls)
  controlsRef.current = controls
  const reads = useRef(0)

  const setControls = useCallback(
    (next: Partial<Controls>) => {
      const qs = queryOf({ ...controlsRef.current, ...next })
      router.replace(`${pathname}${qs ? `?${qs}` : ''}`, { scroll: false })
    },
    [router, pathname],
  )

  const load = useCallback(async () => {
    if (!can.view) return
    const id = ++reads.current
    try {
      const value = await getMilestones(api, companyId)
      if (id === reads.current) setWorld({ status: 'ready', value })
    } catch (error) {
      if (id === reads.current) setWorld({ status: 'error', problem: readProblemOf(error) })
    }
  }, [api, can.view, companyId])

  useEffect(() => {
    void load()
  }, [load])

  const reread = useCoalesced(() => void load(), 1000)
  const live = useLive(
    (change) => {
      if (change.type === 'order_gate.changed' || change.type === 'sample_round.decided' || change.type === 'lot.released' || change.type === 'planning.schedule_changed' || change.type.startsWith('workorder.') || change.type.startsWith('shipment.')) reread()
    },
    () => void load(),
    can.view,
  )

  const gateOf = (id: string): Gate | undefined => (world.status === 'ready' ? world.value.orders.flatMap((order) => order.gates).find((gate) => gate.id === id) : undefined)
  const today = world.status === 'ready' ? world.value.today : new Date().toISOString().slice(0, 10)

  const loadChoices = useCallback(
    (orderId: string) => {
      setDialog((current) => (current && (current.kind === 'add' || current.kind === 'edit') ? { ...current, choices: { status: 'loading' } } : current))
      getChoices(api, orderId)
        .then((value) => setDialog((current) => (current && (current.kind === 'add' || current.kind === 'edit') ? { ...current, choices: { status: 'ready', value } } : current)))
        .catch((error) => setDialog((current) => (current && (current.kind === 'add' || current.kind === 'edit') ? { ...current, choices: { status: 'error', problem: readProblemOf(error) } } : current)))
    },
    [api],
  )

  // ?add= opens Add a gate (`1`: pick the order; an order's id: for it).
  useEffect(() => {
    if (!controls.add || world.status !== 'ready' || dialog !== null) return
    const order = controls.add === '1' ? null : (world.value.orders.find((entry) => entry.id === controls.add) ?? null)
    setDialog({ kind: 'add', orderId: order?.id ?? null, draft: emptyDraft(order ? (kindsLeft(order)[0] ?? 'OTHER') : 'PP_SAMPLE'), choices: null, busy: false, problem: null })
    if (order) loadChoices(order.id)
    // Only when the address asks.
  }, [controls.add, world.status])

  const closeDialog = useCallback(() => {
    setDialog(null)
    if (controlsRef.current.add) setControls({ add: null })
  }, [setControls])

  const saveGate = useCallback(async () => {
    if (!dialog || (dialog.kind !== 'add' && dialog.kind !== 'edit') || dialog.busy) return
    setDialog({ ...dialog, busy: true, problem: null })
    try {
      if (dialog.kind === 'add') {
        if (!dialog.orderId) return
        const gate = await addGate(api, dialog.orderId, bodyOf(dialog.draft))
        setNotice({ tone: 'success', key: gate.state === 'PASSED' ? 'notice.addedPassed' : 'notice.added' })
        closeDialog()
        setControls({ add: null, open: `gate:${gate.id}` })
      } else {
        const gate = gateOf(dialog.gateId)
        if (!gate) return
        const { kind: _kind, ...body } = bodyOf(dialog.draft)
        await editGate(api, gate.id, gate.version, body)
        setNotice({ tone: 'success', key: 'notice.edited' })
        setDialog(null)
      }
      void load()
    } catch (error) {
      setDialog({ ...dialog, busy: false, problem: refusalOf(error) })
      void load()
    }
  }, [api, dialog, world, closeDialog, setControls, load])

  const pass = useCallback(async () => {
    if (dialog?.kind !== 'pass' || dialog.busy) return
    const chosen = dialog.gateIds.map((id) => gateOf(id)).filter((gate): gate is Gate => gate !== undefined)
    setDialog({ ...dialog, busy: true, problem: null })
    try {
      const done = await passGates(api, chosen.map((gate) => ({ id: gate.id, version: gate.version })), dialog.on === today ? undefined : dialog.on)
      setDialog(null)
      setNotice({ tone: 'success', key: 'notice.passed', params: { count: done.passed.length } })
      void load()
    } catch (error) {
      setDialog({ ...dialog, busy: false, problem: refusalOf(error) })
      void load()
    }
  }, [api, dialog, world, today, load])

  const start = useCallback(async () => {
    if (dialog?.kind !== 'startBefore' || dialog.busy) return
    if (reasonHeld(dialog.reason, t)) return
    setDialog({ ...dialog, busy: true, problem: null })
    try {
      for (const id of dialog.gateIds) {
        const gate = gateOf(id)
        if (gate) await startBefore(api, gate.id, gate.version, dialog.reason.trim())
      }
      setDialog(null)
      setNotice({ tone: 'success', key: 'notice.started', params: { count: dialog.gateIds.length } })
      void load()
    } catch (error) {
      setDialog({ ...dialog, busy: false, problem: refusalOf(error) })
      void load()
    }
  }, [api, dialog, world, t, load])

  const remove = useCallback(async () => {
    if (dialog?.kind !== 'remove' || dialog.busy) return
    const gate = gateOf(dialog.gateId)
    if (!gate) return
    setDialog({ ...dialog, busy: true, problem: null })
    try {
      await removeGate(api, gate.id, gate.version)
      setDialog(null)
      setControls({ open: null })
      setNotice({ tone: 'success', key: 'notice.removed' })
      void load()
    } catch (error) {
      setDialog({ ...dialog, busy: false, problem: refusalOf(error) })
      void load()
    }
  }, [api, dialog, world, setControls, load])

  const model: MilestonesModel = { prefix, can, me: session.user.id, controls, world, live, updates: 0, notice, dialog }

  return (
    <MilestonesView
      model={model}
      actions={{
        onView: (view) => setControls({ view }),
        onTile: (tile) => setControls({ tile }),
        onSearch: (q) => setControls({ q }),
        onRetry: () => {
          setWorld({ status: 'loading' })
          void load()
        },
        onOpen: (id) => setControls({ open: id }),
        onOpenOrder: (orderId, newTab) => {
          const href = `${prefix}/sales/orders/${orderId}`
          if (newTab) window.open(href, '_blank', 'noopener')
          else router.push(href)
        },
        onAdd: (orderId) => setControls({ add: orderId ?? '1', open: null }),
        onPickOrder: (orderId) => {
          const order = world.status === 'ready' ? world.value.orders.find((entry) => entry.id === orderId) : undefined
          setDialog((current) => (current?.kind === 'add' ? { ...current, orderId, draft: emptyDraft(order ? (kindsLeft(order)[0] ?? 'OTHER') : current.draft.kind), problem: null } : current))
          loadChoices(orderId)
        },
        onEdit: (gateId) => {
          const gate = gateOf(gateId)
          if (!gate) return
          setDialog({ kind: 'edit', gateId, draft: draftOfGate(gate), choices: null, busy: false, problem: null })
          loadChoices(gate.salesOrderId)
        },
        onDraft: (draft) => setDialog((current) => (current && (current.kind === 'add' || current.kind === 'edit') ? { ...current, draft, problem: null } : current)),
        onSaveGate: () => void saveGate(),
        onPass: (gateIds) => setDialog({ kind: 'pass', gateIds, on: today, busy: false, problem: null }),
        onPassDay: (on) => setDialog((current) => (current?.kind === 'pass' ? { ...current, on, problem: null } : current)),
        onPassConfirm: () => void pass(),
        onStartBefore: (gateIds) => setDialog({ kind: 'startBefore', gateIds, reason: '', busy: false, problem: null }),
        onReason: (reason) => setDialog((current) => (current?.kind === 'startBefore' ? { ...current, reason, problem: null } : current)),
        onStartConfirm: () => void start(),
        onRemove: (gateId) => setDialog({ kind: 'remove', gateId, busy: false, problem: null }),
        onRemoveConfirm: () => void remove(),
        onKeys: () => setDialog({ kind: 'keys' }),
        onCloseDialog: closeDialog,
        onDismissNotice: () => setNotice(null),
      }}
    />
  )
}
