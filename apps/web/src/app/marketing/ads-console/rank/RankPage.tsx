'use client'

import { Crosshair } from 'lucide-react'
import { RankControlTab } from '../automation/RankControlTab'

export function RankPage() {
  return (
    <div className="az-wrap">
      <div className="az-listhead">
        <span className="title"><Crosshair size={18} style={{ marginRight: 6, color: 'var(--orange)' }} />Rank Control</span>
      </div>
      <RankControlTab onSaved={() => {}} />
    </div>
  )
}
