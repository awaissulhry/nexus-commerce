'use client'

import type { CSSProperties } from 'react'
import { Button } from '@nexus/ui/primitives'
import { tableMinWidth } from '../model'
import { WindowShell, type WindowAct } from './WindowShell'

/**
 * owb-b5 (w5.3) — the window frame's lab (`/design/SCR-owb-window-shell`): one window per case, open, with made-up content — a window
 * that acts (Cancel + its act), one that only shows (Close), a held act that says why, a running act, a danger act, and the room
 * rules inside a window (a table that keeps its smallest width and scrolls in its card, two parts that stack in a narrow room, one
 * button height in a title bar). Draws its model; fetches nothing.
 */
export interface WindowShellLabModel {
  readonly show: 'act' | 'show' | 'held' | 'busy' | 'danger' | 'room'
  readonly title: string
  readonly subtitle?: string
  readonly lines: readonly string[]
  readonly actWords?: string
  readonly held?: string
  readonly moreWords?: string
  /** The room case: the table's columns and rows (made up). */
  readonly table?: { readonly columns: readonly string[]; readonly rows: readonly (readonly string[])[] }
}

export function WindowShellLab({ model }: { model: WindowShellLabModel }) {
  const acts = model.show !== 'show'
  const act: WindowAct | null = acts && model.actWords ? { words: model.actWords, onAct: () => undefined, held: model.show === 'held' ? (model.held ?? null) : null, busy: model.show === 'busy', danger: model.show === 'danger' } : null
  return (
    <WindowShell
      open
      onClose={() => undefined}
      title={model.title}
      subtitle={model.subtitle}
      act={act}
      more={model.moreWords ? <Button size="sm" variant="quiet">{model.moreWords}</Button> : undefined}
      size={model.show === 'room' ? 'xl' : 'md'}
    >
      {model.lines.map((line) => (
        <p key={line} className="fw-wsh-lab-line">
          {line}
        </p>
      ))}
      {model.show === 'room' && model.table ? (
        <>
          <div className="fw-room-bar">
            <Button size="sm">{model.table.columns[0]}</Button>
            <Button size="sm" variant="primary">
              {model.table.columns[1]}
            </Button>
          </div>
          <div className="fw-room-stack">
            <p className="fw-wsh-lab-line">{model.lines[0]}</p>
            <p className="fw-wsh-lab-line">{model.lines[1] ?? model.lines[0]}</p>
          </div>
          <div className="fw-room-scroll" style={{ ['--fw-room-min' as string]: `${tableMinWidth(model.table.columns.length)}px` } as CSSProperties}>
            <table className="fw-wsh-lab-table">
              <thead>
                <tr>
                  {model.table.columns.map((column) => (
                    <th key={column}>{column}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {model.table.rows.map((row) => (
                  <tr key={row.join('|')}>
                    {row.map((cell, index) => (
                      <td key={`${index}-${cell}`}>{cell}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </WindowShell>
  )
}
