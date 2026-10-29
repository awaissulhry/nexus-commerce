'use client'

import type { ReactNode } from 'react'
import '../../floor.css'

/**
 * Key facts at floor size (a label over a big value, as many columns as fit). The DS `KeyValue` keeps the console's
 * size (it does not read `--nds-density-*` yet: design "Density-aware existing parts"), so the floor app draws its own
 * list, layout only.
 */
export interface FloorFact {
  label: string
  value: ReactNode
}

export function FloorFacts({ facts }: { facts: readonly FloorFact[] }) {
  return (
    <dl className="fw-floor-facts">
      {facts.map((fact) => (
        <div key={fact.label} className="fw-floor-fact">
          <dt>{fact.label}</dt>
          <dd>{fact.value}</dd>
        </div>
      ))}
    </dl>
  )
}
