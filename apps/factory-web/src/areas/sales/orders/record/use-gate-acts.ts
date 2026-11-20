'use client'

import { useState } from 'react'
import type { LiveState } from '../../../../shell/live/bus'
import { editGate, getChoices, passGates, startBefore, type Gate } from '../../../planning/milestones/api'
import { canOf, DEFAULT_CONTROLS, readProblemOf, reasonHeld, refusalOf, type GateDraft } from '../../../planning/milestones/model'
import type { Loaded, MilestonesActions, MilestonesDialog, MilestonesModel } from '../../../planning/milestones/view-model'
import { romeToday, type Phrase } from '../model'
import type { ProductionPart } from './overview/api'
import { readOf, type ProductionState } from './overview/model'
import { gateChangesOf, gateDraftOf, gateWorldOf } from './overview/dates'
import type { RecordActsBase } from './record-model'

/**
 * F-OO-145 (order overview 10-design §4.2; 13-backend B-OO-010; review F8) — Next dates' steps before production, moved in place with
 * Planning's OWN dialogs (GateDialogs: Change the gate, Mark done, Start before the gate — never a copy). Mounted inside
 * use-overview-acts (the container's hook; a view never imports it, view-boundaries rule 2); Next dates draws GateDialogs with what
 * it returns.
 *
 * The model is Planning's `MilestonesModel` for THIS order alone, built from the order page's own read (the production read's `dates`
 * part: each gate with its version and what THIS reader may do — gateWorldOf, the honest subset; no second read). Only edit, pass and
 * start before are opened here (never Add, Remove or the keys). The writes are Planning's own routes with the gate's version, through
 * the page's one write (`base.write`): a refusal is said in the gate's dialog in Planning's catalogue words (refusalOf: the API's code,
 * never its English message), a success in the page's notice; the order and its dates and headline are read again after either.
 */
export interface GateActsInput {
  /** The production read the page holds (its `dates` part: the order's gates as Planning reads them for this reader). */
  readonly production: ProductionState | null | undefined
  /** Read parts of the production read again (after a write: the dates and the headline, whose waiting rows give the gates' ages). */
  readonly again: (parts?: readonly ProductionPart[]) => void
  /** The reader's rights (Planning's own `Can`: planning.view opens Planning, and its gate choices). */
  readonly permissions: readonly string[]
  /** The reader's id (Planning's model names it). */
  readonly me: string
  /** The workspace's address prefix (`/w/<company>`). */
  readonly prefix: string
  /** The page's live stream. */
  readonly live: LiveState
}

/** The page's notice after a gate write (the `orders` catalogue: the page says its notices in its own words). */
const NOTICE: Readonly<Record<'edit' | 'pass' | 'startBefore', string>> = Object.freeze({ edit: 'dates.gateEdited', pass: 'dates.gatePassed', startBefore: 'dates.gateStarted' })

/**
 * One gate write of Planning's own routes, each with its gate's version as read: Change the gate (only what the person changed,
 * gateChangesOf), Mark done (today: the API's own day; a day before: that day), Start before the gate (the reason, one command per
 * gate). Answers the page's notice; throws the API's refusal.
 */
export async function sendGateDialog(
  api: RecordActsBase['api'],
  dialog: Extract<MilestonesDialog, { kind: 'edit' | 'pass' | 'startBefore' }>,
  input: { readonly gates: readonly Gate[]; readonly initial: GateDraft | null; readonly today: string },
): Promise<Phrase> {
  const gateOf = (id: string): Gate | undefined => input.gates.find((gate) => gate.id === id)
  if (dialog.kind === 'edit') {
    const gate = gateOf(dialog.gateId)
    if (!gate) throw new Error('gate not read')
    await editGate(api, gate.id, gate.version, gateChangesOf(input.initial ?? gateDraftOf(gate), dialog.draft))
    return { key: NOTICE.edit }
  }
  const chosen = dialog.gateIds.map(gateOf).filter((gate): gate is Gate => gate !== undefined)
  if (dialog.kind === 'pass') {
    const done = await passGates(api, chosen.map((gate) => ({ id: gate.id, version: gate.version })), dialog.on === input.today ? undefined : dialog.on)
    return { key: NOTICE.pass, params: { count: done.passed.length } }
  }
  for (const gate of chosen) await startBefore(api, gate.id, gate.version, dialog.reason.trim())
  return { key: NOTICE.startBefore, params: { count: chosen.length } }
}

export function useGateActs(input: GateActsInput | undefined, base: RecordActsBase | undefined): { model: MilestonesModel | null; actions: MilestonesActions } {
  const [dialog, setDialog] = useState<MilestonesDialog | null>(null)
  // The Change the gate draft as it opened (Save sends only what changed from it).
  const [initial, setInitial] = useState<GateDraft | null>(null)
  const order = base?.current.current ?? null
  const today = romeToday()
  const state = input?.production ?? null
  const world = order ? gateWorldOf(order, readOf(state)?.dates ?? null, today) : null
  const gates: readonly Gate[] = world?.orders[0]?.gates ?? []
  const gateOf = (id: string): Gate | undefined => gates.find((gate) => gate.id === id)
  const can = canOf(input?.permissions ?? [])
  const loaded: Loaded<NonNullable<typeof world>> = world ? { status: 'ready', value: world } : state?.status === 'failed' ? { status: 'error', problem: 'error.failed' } : { status: 'loading' }
  const model: MilestonesModel | null = input && order ? { prefix: input.prefix, can, me: input.me, controls: DEFAULT_CONTROLS, world: loaded, live: input.live, updates: 0, notice: null, dialog } : null

  // Planning's own choices for Change the gate (its rounds and planners; planning.view): without the right, the dialog says it saves without them.
  const loadChoices = (orderId: string) => {
    if (!base || !can.view) return setDialog((current) => (current?.kind === 'edit' ? { ...current, choices: { status: 'error', problem: 'error.forbidden' } } : current))
    setDialog((current) => (current?.kind === 'edit' ? { ...current, choices: { status: 'loading' } } : current))
    getChoices(base.api, orderId)
      .then((value) => setDialog((current) => (current?.kind === 'edit' ? { ...current, choices: { status: 'ready', value } } : current)))
      .catch((error: unknown) => setDialog((current) => (current?.kind === 'edit' ? { ...current, choices: { status: 'error', problem: readProblemOf(error) } } : current)))
  }

  // The page's one write: the dialog says it saves; taken — it closes and the page's notice says so; refused — Planning's words in it.
  const send = (open: Extract<MilestonesDialog, { kind: 'edit' | 'pass' | 'startBefore' }>) => {
    if (!base || open.busy) return
    void base.write(
      async () => {
        setDialog({ ...open, busy: true, problem: null })
        try {
          const words = await sendGateDialog(base.api, open, { gates, initial, today })
          setDialog(null)
          base.setNotice({ tone: 'success', words })
        } catch (error) {
          setDialog({ ...open, busy: false, problem: refusalOf(error) })
        }
        input?.again(['dates', 'headline'])
        return null
      },
      null,
      true,
    )
  }

  return {
    model,
    actions: {
      onEdit: (gateId) => {
        const gate = gateOf(gateId)
        if (!gate) return
        const draft = gateDraftOf(gate)
        setInitial(draft)
        setDialog({ kind: 'edit', gateId, draft, choices: null, busy: false, problem: null })
        loadChoices(gate.salesOrderId)
      },
      onDraft: (draft) => setDialog((current) => (current?.kind === 'edit' ? { ...current, draft, problem: null } : current)),
      onSaveGate: () => {
        if (dialog?.kind === 'edit') send(dialog)
      },
      onPass: (gateIds) => setDialog({ kind: 'pass', gateIds, on: today, busy: false, problem: null }),
      onPassDay: (on) => setDialog((current) => (current?.kind === 'pass' ? { ...current, on, problem: null } : current)),
      onPassConfirm: () => {
        if (dialog?.kind === 'pass') send(dialog)
      },
      onStartBefore: (gateIds) => setDialog({ kind: 'startBefore', gateIds, reason: '', busy: false, problem: null }),
      onReason: (reason) => setDialog((current) => (current?.kind === 'startBefore' ? { ...current, reason, problem: null } : current)),
      onStartConfirm: () => {
        // The reason's own rule (Planning's: enough words, not too many) — the dialog holds Go by it in words.
        if (dialog?.kind === 'startBefore' && !reasonHeld(dialog.reason, (key) => key)) send(dialog)
      },
      onCloseDialog: () => setDialog(null),
    },
  }
}
