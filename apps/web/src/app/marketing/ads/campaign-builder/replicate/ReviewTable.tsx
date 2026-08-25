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
import { useState } from 'react'
import { AlertTriangle, Trash2, RotateCcw, Check, Pencil } from 'lucide-react'
import { Input, Select, ToolbarButton } from '@/design-system/primitives'
import { DataGrid } from '@/design-system/components'
import { InfoTip } from '../../campaigns/InfoTip'
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

  if (!rows.length) {
    return <div className="h10-rep-empty">Nothing here matches the current filter.</div>
  }

  return (
    <DataGrid<TargetView>
      className="h10-rep-tbl"
      rows={rows}
      rowKey={(r) => r.id}
      selectable
      selected={selected}
      onSelectedChange={(next) => {
        const on = [...next].filter((id) => !selected.has(id))
        const off = [...selected].filter((id) => !next.has(id))
        if (on.length) onSelect(on, true)
        if (off.length) onSelect(off, false)
      }}
      sort={{ key: sort.key, dir: sort.dir === 1 ? 'asc' : 'desc' }}
      onSortChange={(next) => setSort({ key: next.key as SortKey, dir: next.dir === 'asc' ? 1 : -1 })}
      rowClassName={(r) => [r.removed ? 'cut' : '', r.conflict && r.decision !== 'accept' && !r.removed ? 'conflict' : '', r.added ? 'added' : ''].filter(Boolean).join(' ')}
      columns={[
        {
          key: 'expression', label: 'Target', sortable: true, sortValue: (r) => r.expression,
          render: (r) => (
            <span className="exp">
              {editing === r.id ? (
                <Input
                  size="sm" fieldClassName="expedit" defaultValue={r.expression} autoFocus aria-label={`Rewrite ${r.expression}`}
                  onBlur={(e) => { setEditing(null); if (e.target.value.trim() && e.target.value !== r.expression) onExpression(r, e.target.value.trim()) }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                    if (e.key === 'Escape') setEditing(null)
                  }}
                />
              ) : (
                <InfoTip tip="Click to rewrite this target. A rewritten keyword is re-checked against the campaigns you already run, so it cannot be edited past the self-competition gate.">
                  <button type="button" className="expbtn" onClick={() => setEditing(r.id)}>
                    <code>{r.expression}</code>
                    <Pencil size={11} className="pen" aria-hidden />
                  </button>
                </InfoTip>
              )}
              {r.isNegative && <span className="tag neg">negative</span>}
              {r.added && <span className="tag new">added</span>}
              {r.touched && !r.added && <span className="tag edited">edited</span>}
              {showWhere && (
                <button type="button" className="whrline" onClick={() => onGoTo?.(r)} title="Show this ad group">
                  {r.campaignName} › {r.adGroupName}
                </button>
              )}
            </span>
          ),
        },
        {
          key: 'match', label: 'Match', sortable: true, sortValue: (r) => matchLabel(r), width: 118,
          render: (r) => (isKeyword(r) ? (
            <InfoTip tip={r.isNegative
              ? 'How widely this exclusion applies. Exact blocks only this phrase; phrase blocks any search containing it. Amazon accepts no other match type for a negative, and caps phrase negatives at 4 words.'
              : 'Exact matches this phrase only. Phrase matches searches containing it in order. Broad matches related searches — widest reach, loosest intent.'}>
              <Select size="sm" value={r.matchType.toUpperCase().replace(/^_/, '')} aria-label={`Match type for ${r.expression}`}
                onChange={(e) => onMatch(r, e.target.value)}>
                {(r.isNegative ? NEGATIVE_MATCH_TYPES : MATCH_TYPES).map((m) => (
                  <option key={m} value={m}>{m.toLowerCase()}</option>
                ))}
              </Select>
            </InfoTip>
          ) : (
            <InfoTip tip={r.kind?.toUpperCase() === 'AUTO'
              ? 'An Amazon auto-targeting clause. Amazon creates these itself when the ad group is made, and decides what they match.'
              : 'A product or category target — it matches a specific ASIN or browse node rather than a search phrase, so it has no match type.'}>
              <span className="tag">{matchLabel(r)}</span>
            </InfoTip>
          )),
        },
        {
          key: 'bid', label: 'Bid', sortable: true, sortValue: (r) => r.effectiveBidCents ?? 0, width: 94,
          render: (r) => (r.isNegative ? (
            <InfoTip tip="A negative keyword has no bid — it excludes traffic rather than buying it."><span className="dash">—</span></InfoTip>
          ) : (
            <label className="inl" title={r.bidCents == null ? `Inherited from the ad group's default bid. Type a number to give "${r.expression}" its own.` : `This target's own bid, overriding the ad group default.`}>
              <span>€</span>
              <input inputMode="decimal" defaultValue={eur(r.effectiveBidCents)} key={`${r.id}:${r.effectiveBidCents}`}
                aria-label={`Bid for ${r.expression}`}
                onBlur={(e) => {
                  const cents = Math.round((Number(e.target.value) || 0) * 100)
                  if (cents !== r.effectiveBidCents) onBid(r, cents)
                }} />
            </label>
          )),
        },
        ...(showWhere ? [{
          key: 'where', label: 'Where', sortable: true, sortValue: (r: TargetView) => `${r.campaignName}${r.adGroupName}`, width: 132,
          render: (r: TargetView) => (
            <button type="button" className="whrbtn" title={`Show ${r.adGroupName} in the structure view`} onClick={() => onGoTo?.(r)}>
              {r.campaignName.replace(/^[A-Z]{2}-/, '')}
            </button>
          ),
        }] : []),
        {
          key: 'status', label: 'Status', sortable: true, width: 300,
          sortValue: (r) => `${r.conflict && r.decision !== 'accept' && !r.removed ? 0 : r.removed ? 2 : 1}\u0000${r.expression}`,
          render: (r) => (
            <span className="st">
              {r.removed ? (
                <span className="pill cut">dropped</span>
              ) : r.conflict ? (
                <span className="cf">
                  <AlertTriangle size={12} aria-hidden />
                  <span className="who" title={r.conflict.map((c) => c.campaignName).join(', ')}>
                    competes with {r.conflict[0]!.campaignName}{r.conflict.length > 1 ? ` +${r.conflict.length - 1}` : ''}
                  </span>
                  {r.decision === 'accept'
                    ? (
                      <InfoTip tip={`You accepted this conflict: "${r.expression}" will be created, and this product will bid in the same auction as ${r.conflict.map((c) => c.campaignName).join(', ')}. Drop it with the bin on the right to undo.`}>
                        <span className="pill ok"><Check size={11} aria-hidden /> accepted</span>
                      </InfoTip>
                    )
                    : (
                      <InfoTip tip={`Create "${r.expression}" anyway, knowing it bids against ${r.conflict.map((c) => c.campaignName).join(', ')}. You raise your own clearing price and split one pool of demand between two of your products — sometimes worth it, never accidental. Applies to every ad group carrying this keyword.`}>
                        <button type="button" className="mini" onClick={() => onConflict(r, 'accept')}>Accept</button>
                      </InfoTip>
                    )}
                </span>
              ) : (
                <span className="pill ok">will be created</span>
              )}
            </span>
          ),
        },
        {
          key: 'act', label: '', align: 'right', width: 46,
          render: (r) => (
            <InfoTip tip={r.removed
              ? `Put "${r.expression}" back into the plan.`
              : r.conflict
                ? `Drop "${r.expression}" — it will not be created, which resolves its conflict. Applies to every ad group carrying this keyword, not just this row.`
                : `Drop "${r.expression}" — it will not be created. Nothing on Amazon changes until you launch.`}>
              <ToolbarButton
                size="sm" tooltip={false} tone={r.removed ? 'neutral' : 'danger'} active={r.removed}
                icon={r.removed ? <RotateCcw size={14} /> : <Trash2 size={14} />}
                label={r.removed ? `Restore ${r.expression}` : `Drop ${r.expression}`}
                onClick={() => onRemove(r)}
              />
            </InfoTip>
          ),
        },
      ]}
    />
  )
}
