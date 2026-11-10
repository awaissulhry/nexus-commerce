'use client'

import { useCallback, useState, type ReactNode } from 'react'
import type { ApiClient } from '../../../lib/api/client'
import { useLocale, useT } from '../../../lib/i18n/provider'
import { WithMessages } from '../../../record-panels/i18n'
import { getMilestones, startBefore, type Gate, type Milestones } from './api'
import { dayText, gateName, heldOf, NAMESPACE, reasonHeld, refusalOf } from './model'
import { StartBeforeDialog } from './view/StartBeforeDialog'

interface Asking {
  readonly world: Milestones
  readonly gates: readonly Gate[]
  readonly reason: string
  readonly busy: boolean
  readonly problem: string | null
  readonly resolve: (started: boolean) => void
}

/**
 * "Start before the gate?" for another screen (B-W2b-263; design pop:gate-override "Board drop or milestone popover"): the
 * planning board's drop that the API held (409 `refusal/GATE_NOT_PASSED`, issues `gate/<id>`) asks it here. `ask(gateIds)`
 * reads the gates as they are now (GET /planning/milestones of the company), shows the dialog (which gate, why, the reason,
 * who may), starts before each with the reason (one command each) and answers true when every one was started before (the
 * caller sends its drop again), false when the person cancels or nothing could be read. `element` is drawn by the caller.
 */
export function useStartBeforeGate(api: ApiClient, companyId: string | null): { ask: (gateIds: readonly string[]) => Promise<boolean>; element: ReactNode } {
  const [asking, setAsking] = useState<Asking | null>(null)

  const ask = useCallback(
    async (gateIds: readonly string[]): Promise<boolean> => {
      let world: Milestones
      try {
        world = await getMilestones(api, companyId)
      } catch {
        return false
      }
      const gates = world.orders.flatMap((order) => order.gates).filter((gate) => gateIds.includes(gate.id) && gate.state === 'WAITING')
      if (gates.length === 0) return gateIds.length > 0
      return new Promise<boolean>((resolve) => setAsking({ world, gates, reason: '', busy: false, problem: null, resolve }))
    },
    [api, companyId],
  )

  const confirm = useCallback(async () => {
    if (!asking || asking.busy) return
    setAsking({ ...asking, busy: true, problem: null })
    try {
      for (const gate of asking.gates) await startBefore(api, gate.id, gate.version, asking.reason.trim())
      asking.resolve(true)
      setAsking(null)
    } catch (error) {
      setAsking({ ...asking, busy: false, problem: refusalOf(error) })
    }
  }, [api, asking])

  const cancel = useCallback(() => {
    asking?.resolve(false)
    setAsking(null)
  }, [asking])

  const element = asking ? (
    <WithMessages namespaces={[NAMESPACE]}>
      <StartBeforeHost asking={asking} onReason={(reason) => setAsking({ ...asking, reason, problem: null })} onConfirm={() => void confirm()} onCancel={cancel} />
    </WithMessages>
  ) : null
  return { ask, element }
}

function StartBeforeHost({ asking, onReason, onConfirm, onCancel }: { asking: Asking; onReason: (reason: string) => void; onConfirm: () => void; onCancel: () => void }) {
  const t = useT(NAMESPACE)
  const locale = useLocale()
  const orderOf = (id: string) => asking.world.orders.find((order) => order.id === id)?.number ?? ''
  const rows = asking.gates.map((gate) => ({ id: gate.id, name: gateName(gate.kind, gate.label, t), order: orderOf(gate.salesOrderId), target: dayText(gate.targetDate, locale), owner: gate.owner?.name ?? null, held: heldOf(gate.actions.startBefore, t) }))
  const held = rows.find((row) => row.held)?.held ?? reasonHeld(asking.reason, t)
  return <StartBeforeDialog gates={rows} reason={asking.reason} busy={asking.busy} problem={asking.problem} held={held} onReason={onReason} onConfirm={onConfirm} onCancel={onCancel} t={t} />
}
