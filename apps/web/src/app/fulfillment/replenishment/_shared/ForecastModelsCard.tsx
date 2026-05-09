'use client'

/**
 * W9.6f — Forecast model A/B card (R.16 origin).
 *
 * Extracted from ReplenishmentWorkspace.tsx. Shows the current
 * champion + any rolled-out challengers with cohort sizes. Silent
 * until the system has at least one challenger active — fresh
 * installs / champion-only state render nothing so the workspace
 * doesn't carry empty content.
 *
 * Adds dark-mode classes to the bright-mode-only chrome.
 */

import { useEffect, useState } from 'react'
import { Card } from '@/components/ui/Card'
import { getBackendUrl } from '@/lib/backend-url'

interface Challenger {
  modelId: string
  skuCount: number
}

interface ForecastModelsResponse {
  champion: { modelId: string; skuCount: number } | null
  challengers: Challenger[]
  defaultModelId: string
}

export function ForecastModelsCard() {
  const [data, setData] = useState<ForecastModelsResponse | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    fetch(
      `${getBackendUrl()}/api/fulfillment/replenishment/forecast-models/active`,
      { cache: 'no-store' },
    )
      .then((r) => (r.ok ? r.json() : null))
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false))
  }, [])

  if (loading || !data) return null
  const challengers = data.challengers ?? []
  if (challengers.length === 0) return null // silent in champion-only state

  return (
    <Card>
      <div>
        <div className="text-sm uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold">
          Forecast model A/B
        </div>
        <div className="mt-1 flex items-baseline gap-3 flex-wrap">
          <span className="text-base text-slate-700 dark:text-slate-300">
            Champion:{' '}
            <span className="font-mono">
              {data.champion?.modelId ?? data.defaultModelId}
            </span>
            <span className="text-slate-500 dark:text-slate-400 ml-1">
              ({data.champion?.skuCount ?? 0} SKUs)
            </span>
          </span>
          {challengers.map((c) => (
            <span
              key={c.modelId}
              className="text-base text-violet-700 dark:text-violet-400"
            >
              Challenger: <span className="font-mono">{c.modelId}</span>
              <span className="text-violet-500 dark:text-violet-500 ml-1">
                ({c.skuCount} SKUs)
              </span>
            </span>
          ))}
        </div>
        <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
          Compare MAPE per model in the Forecast Health card. Promote via
          <span className="font-mono"> POST /forecast-models/promote</span>.
        </div>
      </div>
    </Card>
  )
}
