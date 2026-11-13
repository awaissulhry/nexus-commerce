'use client'

import { Check } from 'lucide-react'
import { formatNumber } from '../../../../../lib/i18n/format'
import type { Locale } from '../../../../../lib/i18n/locales'
import type { Translate } from '../../../../../lib/i18n/messages'
import { cellName, type PackGrid } from '../model'

/**
 * The size grid, live (B-W2b-387; design floor.pack "Scan into the carton": "Size grid: ordered vs packed, live"). Composed
 * here: the DS SizeGridView reads one number per cell and has no cell to tap, and this grid needs "packed of ordered" in
 * each cell and, when a batch label names no size, the sizes it may be as big buttons (DS gap, named in the step's notes).
 * Rows: style · colour; columns: the sizes in the lines' order. A cell's state is its tone AND its numbers (and a tick
 * when done), never colour alone.
 */
export function PackSizeGrid({ grid, choosing, onChoose, t, locale }: { grid: PackGrid; choosing: readonly string[] | null; onChoose: (cellId: string) => void; t: Translate; locale: Locale }) {
  const n = (value: number) => formatNumber(value, locale)
  return (
    <div className="fw-pack-grid-wrap">
      <table className="fw-pack-grid" data-choosing={choosing ? 'true' : undefined}>
        <caption className="fw-pack-sr">{t('grid.caption')}</caption>
        <thead>
          <tr>
            <th scope="col">{t('grid.style')}</th>
            {grid.sizes.map((size) => (
              <th key={size} scope="col">
                {size}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {grid.rows.map((row) => (
            <tr key={row.key}>
              <th scope="row">
                <span className="fw-pack-code">{`${row.styleCode} · ${row.colourwayCode}`}</span>
                {row.serialTracked ? <span className="fw-pack-grid-serial">{t('grid.serials')}</span> : null}
              </th>
              {row.cells.map((cell, index) => {
                if (!cell) {
                  return (
                    <td key={grid.sizes[index]} data-state="none">
                      <span aria-hidden="true">—</span>
                    </td>
                  )
                }
                const words = { cell: cellName(row, cell.size), packed: n(cell.packed), ordered: n(cell.ordered) }
                const choice = choosing ? cell.cellIds.find((id) => choosing.includes(id)) : undefined
                const content = (
                  <>
                    {cell.state === 'done' ? (
                      <span className="fw-pack-grid-tick" aria-hidden="true">
                        <Check />
                      </span>
                    ) : null}
                    <span aria-hidden="true">{t('grid.cell', { packed: n(cell.packed), ordered: n(cell.ordered) })}</span>
                  </>
                )
                return (
                  <td key={cell.size} data-state={cell.state}>
                    {choice ? (
                      <button type="button" className="fw-pack-grid-choose" aria-label={t('grid.choose', words)} onClick={() => onChoose(choice)}>
                        {content}
                      </button>
                    ) : (
                      <>
                        {content}
                        <span className="fw-pack-sr">{t('grid.cellName', words)}</span>
                      </>
                    )}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
