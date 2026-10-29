'use client'

import type { ReactNode } from 'react'
import type { ICellRendererParams } from '@nexus/ui/grid'

/**
 * A list frame cell from a drawing of its row (the column builders of every Admin list use it). The builders are
 * exported, so a test draws each cell alone: AG Grid draws cells only in a browser.
 */
export const cellOf = <T,>(draw: (row: T) => ReactNode) =>
  function Cell({ data }: ICellRendererParams<T>) {
    return data ? <>{draw(data)}</> : null
  }
