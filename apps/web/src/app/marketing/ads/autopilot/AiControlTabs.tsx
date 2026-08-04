'use client'

/**
 * ADX N4 — two views on one rail entry.
 *
 * "AI Control" already showed Mission Control, the operational object graph. The
 * autonomy board is the other half of the same question: the graph shows the account's
 * shape, the board shows what is allowed to change it without asking.
 *
 * A tab rather than a new rail entry, per the standing constraint — in-page navigation
 * is fine, sidebar navigation is not.
 *
 * Autonomy is the default tab. Ten rules act on this account on their own; that is the
 * thing an operator opening "AI Control" most needs to see first.
 */

import { useState } from 'react'
import { Gauge, SlidersHorizontal } from 'lucide-react'
import { MissionControlClient } from './MissionControlClient'
import { AutonomyBoard } from './AutonomyBoard'

type Tab = 'autonomy' | 'canvas'

export function AiControlTabs() {
  const [tab, setTab] = useState<Tab>('autonomy')
  return (
    <>
      <div className="h10-cd-tabs" role="tablist" aria-label="AI Control views">
        <button
          type="button" role="tab" aria-selected={tab === 'autonomy'}
          className={`h10-cd-tab ${tab === 'autonomy' ? 'on' : ''}`}
          onClick={() => setTab('autonomy')}
        ><SlidersHorizontal size={13} /> Autonomy</button>
        <button
          type="button" role="tab" aria-selected={tab === 'canvas'}
          className={`h10-cd-tab ${tab === 'canvas' ? 'on' : ''}`}
          onClick={() => setTab('canvas')}
        ><Gauge size={13} /> Mission Control</button>
      </div>
      {tab === 'autonomy' ? <AutonomyBoard /> : <MissionControlClient />}
    </>
  )
}
