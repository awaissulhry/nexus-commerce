'use client'

import { useState } from 'react'
import { Clock, Hand, Pin } from 'lucide-react'
import { FloorButton, useConfirmFeedback } from '@nexus/ui/floor'
import { useFloorWords } from '../../../lib/floor-words/FloorWords'
import { useT } from '../../../lib/i18n/provider'
import { useFloor } from '../../FloorApp'
import { GiveWindow } from '../../leader/GiveWindow'
import { setFirst, tellLate, type LATE_DAYS, type LateReason } from '../api'
import type { BasketView } from '../model'
import { BASKET_NS } from '../parts'
import { LateWindow } from './LateWindow'
import '../basket.css'

/**
 * owb-fl6 steps 3–4 (design § 5zg C "The leader has 3 more in one row: Give to… · Do this first · Will be late") — the team leader's row
 * on the basket page, each button only where the read says the leader may (`can.give`, `can.flag`, `can.late`). Do this first is a toggle
 * (the basket goes on top for the workers); Will be late opens its window; Give to… the people of the team. Online in fl6 (the offline
 * kinds `production.baskets.flag` / `.late` come with server B's fl3).
 */
export function LeaderRow({ view, onChanged }: { readonly view: BasketView; readonly onChanged: () => void }) {
  const { api, sessionEnded } = useFloor()
  const tb = useT(BASKET_NS)
  const feedback = useConfirmFeedback()
  const fw = useFloorWords(BASKET_NS)
  const [give, setGive] = useState(false)
  const [late, setLate] = useState<{ readonly days: (typeof LATE_DAYS)[number] | null; readonly said: string | null } | null>(null)
  const [busy, setBusy] = useState(false)
  const [said, setSaid] = useState<string | null>(null)
  const { can, basket, flags } = view
  if (!can.give && !can.flag && !can.late) return null

  const failed = (kind: string, message?: string) => (kind === 'refused' ? message || tb('dock.failed') : kind === 'offline' ? tb('dock.needsNetwork') : tb('dock.failed'))

  const toggleFirst = async () => {
    if (busy) return
    setBusy(true)
    const answer = await setFirst(api, [basket.id], !flags.first)
    setBusy(false)
    if (!answer.ok) {
      if (answer.problem.kind === 'signedOut') return void sessionEnded()
      feedback('error')
      return setSaid(failed(answer.problem.kind, answer.problem.kind === 'refused' ? answer.problem.message : undefined))
    }
    feedback('success')
    setSaid(tb(flags.first ? 'leader.firstOff' : 'leader.firstOn'))
    onChanged()
  }

  const sendLate = async (reason: LateReason) => {
    if (busy || !late || late.days === null) return
    setBusy(true)
    const answer = await tellLate(api, [basket.id], late.days, reason)
    setBusy(false)
    if (!answer.ok) {
      if (answer.problem.kind === 'signedOut') return void sessionEnded()
      feedback('error')
      return setLate({ ...late, said: failed(answer.problem.kind, answer.problem.kind === 'refused' ? answer.problem.message : undefined) })
    }
    feedback('success')
    setLate(null)
    setSaid(tb('late.told'))
    onChanged()
  }

  const held = busy ? tb('homePage.loading') : null
  return (
    <>
      <div className="fw-bk-lead" role="group" aria-label={tb('leader.row')}>
        {can.give ? (
          <FloorButton size="md" variant="secondary" icon={<Hand />} heldReason={held} onClick={() => setGive(true)}>
            {fw('leader.giveTo')}
          </FloorButton>
        ) : null}
        {can.flag ? (
          <FloorButton size="md" variant={flags.first ? 'primary' : 'secondary'} aria-pressed={flags.first} icon={<Pin />} heldReason={held} onClick={() => void toggleFirst()}>
            {fw('leader.doFirst')}
          </FloorButton>
        ) : null}
        {can.late ? (
          <FloorButton size="md" variant="danger" icon={<Clock />} heldReason={held} onClick={() => setLate({ days: null, said: null })}>
            {fw('leader.willLate')}
          </FloorButton>
        ) : null}
      </div>
      {said ? (
        <p role="status" className="fw-bk-dock-note">
          {said}
        </p>
      ) : null}
      {can.give ? <GiveWindow open={give} onClose={() => setGive(false)} from={{ kind: 'basket', bundleId: basket.id, code: basket.code }} onChanged={onChanged} /> : null}
      {can.late ? (
        <LateWindow
          model={{ open: late !== null, code: basket.code, days: late?.days ?? null, said: late?.said ?? null, busy }}
          onAction={(action) => {
            if (action.type === 'close') return setLate(null)
            if (action.type === 'days') return setLate({ days: action.days, said: null })
            return void sendLate(action.reason)
          }}
        />
      ) : null}
    </>
  )
}
