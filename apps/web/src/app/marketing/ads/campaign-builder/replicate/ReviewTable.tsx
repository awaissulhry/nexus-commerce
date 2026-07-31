'use client'

/**
 * AX3.7 — the target table.
 *
 * Every keyword, negative, product target and auto clause the replication would
 * create, as an editable row. The old review step buried these three levels deep
 * in a collapsed tree, so a plan with 43 conflicts spread across 345 rows had no
 * reachable resolution: the screen you were sent to showed eleven campaign names
 * and nothing else. This is the same data as a table you can scan, filter, sort
 * and multi-select.
 *
 * Nothing here mutates a plan — it emits edits, which the server replays onto a
 * freshly-built plan and re-gates. The gate cannot be edited around.
 */
import { useMemo, useState, type ReactNode } from 'react'
import { AlertTriangle, Trash2, RotateCcw, Check, Pencil } from 'lucide-react'
import { Select, Checkbox } from '@/design-system/primitives'
import type { TargetView } from './edit-model'
import { MATCH_TYPES, NEGATIVE_MATCH_TYPES } from './replicate-types'

export type SortKey = 'expression' | 'match' | 'bid' | 'where' | 'status'

export interface TargetTableProps {
  rows: TargetView[]
  /** Show which campaign / ad group each row belongs to. On in the flat view. */
  showWhere: boolean
  selected: Set<string>
  onSelect: (ids: string[], on: boolean) => void
  onExpression: (row: TargetView, expression: string) => void
  onMatch: (row: TargetView, matchType: string) => void
  onBid: (row: TargetView, bidCents: number) => void
  onRemove: (row: TargetView) => void
  onConflict: (row: TargetView, decision: 'skip' | 'accept') => void
  /** Jump the left rail to this row's ad group — the flat view's way back. */
  onGoTo?: (row: TargetView) => void
}

const eur = (cents: number | null) => ((cents ?? 0) / 100).toFixed(2)

/** A target's match type, without the negative marker the blueprint carries. */
export const matchLabel = (r: TargetView): string =>
  r.kind?.toUpperCase() === 'AUTO'
    ? (r.autoClause ?? 'auto').replace(/_/g, ' ').toLowerCase()
    : (r.matchType ?? '').toUpperCase().replace(/^_/, '').toLowerCase()

/** Keyword rows take a match type; auto clauses and product targets do not. */
const isKeyword = (r: TargetView) => (r.kind ?? 'KEYWORD').toUpperCase() === 'KEYWORD'

export function TargetTable({
  rows, showWhere, selected, onSelect, onExpression, onMatch, onBid, onRemove, onConflict, onGoTo,
}: TargetTableProps) {
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'status', dir: 1 })
  const [editing, setEditing] = useState<string | null>(null)

  const sorted = useMemo(() => {
    const rank = (r: TargetView) => (r.conflict && r.decision !== 'accept' && !r.removed ? 0 : r.removed ? 2 : 1)
    const by: Record<SortKey, (a: TargetView, b: TargetView) => number> = {
      expression: (a, b) => a.expression.localeCompare(b.expression),
      match: (a, b) => matchLabel(a).localeCompare(matchLabel(b)),
      bid: (a, b) => (a.effectiveBidCents ?? 0) - (b.effectiveBidCents ?? 0),
      where: (a, b) => `${a.campaignName}${a.adGroupName}`.localeCompare(`${b.campaignName}${b.adGroupName}`),
      status: (a, b) => rank(a) - rank(b) || a.expression.localeCompare(b.expression),
    }
    return [...rows].sort((a, b) => by[sort.key](a, b) * sort.dir)
  }, [rows, sort])

  const allOn = sorted.length > 0 && sorted.every((r) => selected.has(r.id))
  const someOn = sorted.some((r) => selected.has(r.id))

  const Th = ({ k, children, className }: { k: SortKey; children: ReactNode; className?: string }) => (
    <th className={className}>
      <button type="button" className={`srt ${sort.key === k ? 'on' : ''}`}
        onClick={() => setSort((s) => ({ key: k, dir: s.key === k && s.dir === 1 ? -1 : 1 }))}>
        {children}{sort.key === k && <span className="ar">{sort.dir === 1 ? '↑' : '↓'}</span>}
      </button>
    </th>
  )

  if (!rows.length) {
    return <div className="h10-rep-empty">Nothing here matches the current filter.</div>
  }

  return (
    <div className="h10-rep-tblwrap">
      <table className="h10-rep-tbl">
        <thead>
          <tr>
            <th className="chk">
              <Checkbox checked={allOn} aria-label={allOn ? 'Deselect all rows' : 'Select all rows'}
                onChange={() => onSelect(sorted.map((r) => r.id), !allOn)}
                className={!allOn && someOn ? 'part' : undefined} />
            </th>
            <Th k="expression">Target</Th>
            <Th k="match" className="mt">Match</Th>
            <Th k="bid" className="bid">Bid</Th>
            {showWhere && <Th k="where" className="whr">Where</Th>}
            <Th k="status" className="st">Status</Th>
            <th className="act" aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => {
            const live = r.conflict && r.decision !== 'accept' && !r.removed
            return (
              <tr key={r.id} className={`${r.removed ? 'cut' : ''} ${live ? 'conflict' : ''} ${r.added ? 'added' : ''}`}>
                <td className="chk">
                  <Checkbox checked={selected.has(r.id)} onChange={() => onSelect([r.id], !selected.has(r.id))}
                    aria-label={`Select ${r.expression}`} />
                </td>
                <td className="exp">
                  {editing === r.id ? (
                    <input
                      className="expedit" defaultValue={r.expression} autoFocus aria-label={`Rewrite ${r.expression}`}
                      onBlur={(e) => { setEditing(null); if (e.target.value.trim() && e.target.value !== r.expression) onExpression(r, e.target.value.trim()) }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                        if (e.key === 'Escape') setEditing(null)
                      }}
                    />
                  ) : (
                    <button type="button" className="expbtn" onClick={() => setEditing(r.id)} title="Rewrite this target">
                      <code>{r.expression}</code>
                      <Pencil size={11} className="pen" aria-hidden />
                    </button>
                  )}
                  {r.isNegative && <span className="tag neg">negative</span>}
                  {r.added && <span className="tag new">added</span>}
                  {r.touched && !r.added && <span className="tag edited">edited</span>}
                  {showWhere && (
                    <button type="button" className="whrline" onClick={() => onGoTo?.(r)} title="Show this ad group">
                      {r.campaignName} › {r.adGroupName}
                    </button>
                  )}
                </td>
                <td className="mt">
                  {isKeyword(r) ? (
                    <Select value={r.matchType.toUpperCase().replace(/^_/, '')} aria-label={`Match type for ${r.expression}`}
                      onChange={(e) => onMatch(r, e.target.value)}>
                      {(r.isNegative ? NEGATIVE_MATCH_TYPES : MATCH_TYPES).map((m) => (
                        <option key={m} value={m}>{m.toLowerCase()}</option>
                      ))}
                    </Select>
                  ) : (
                    <span className="tag">{matchLabel(r)}</span>
                  )}
                </td>
                <td className="bid">
                  {r.isNegative ? <span className="dash">—</span> : (
                    <label className="inl">
                      <span>€</span>
                      <input inputMode="decimal" defaultValue={eur(r.effectiveBidCents)} key={`${r.id}:${r.effectiveBidCents}`}
                        aria-label={`Bid for ${r.expression}`}
                        onBlur={(e) => {
                          const cents = Math.round((Number(e.target.value) || 0) * 100)
                          if (cents !== r.effectiveBidCents) onBid(r, cents)
                        }} />
                    </label>
                  )}
                </td>
                {showWhere && (
                  <td className="whr">
                    <button type="button" className="whrbtn" onClick={() => onGoTo?.(r)}>
                      {r.campaignName.replace(/^[A-Z]{2}-/, '')}
                    </button>
                  </td>
                )}
                <td className="st">
                  {r.removed ? (
                    <span className="pill cut">dropped</span>
                  ) : r.conflict ? (
                    <span className="cf">
                      <AlertTriangle size={12} aria-hidden />
                      <span className="who" title={r.conflict.map((c) => c.campaignName).join(', ')}>
                        competes with {r.conflict[0]!.campaignName}{r.conflict.length > 1 ? ` +${r.conflict.length - 1}` : ''}
                      </span>
                      {r.decision === 'accept'
                        ? <span className="pill ok"><Check size={11} aria-hidden /> accepted</span>
                        : <button type="button" className="mini" onClick={() => onConflict(r, 'accept')}>Accept</button>}
                    </span>
                  ) : (
                    <span className="pill ok">will be created</span>
                  )}
                </td>
                <td className="act">
                  <button type="button" className={`cutbtn ${r.removed ? 'on' : ''}`} onClick={() => onRemove(r)}
                    aria-label={r.removed ? `Restore ${r.expression}` : `Drop ${r.expression}`}>
                    {r.removed ? <RotateCcw size={14} /> : <Trash2 size={14} />}
                  </button>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
