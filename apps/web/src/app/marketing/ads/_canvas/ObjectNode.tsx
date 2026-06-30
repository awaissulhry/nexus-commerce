import { Handle, Position, type NodeProps } from '@xyflow/react'
import type { OpsNodeData } from './types'

const KIND_LABEL: Record<string, string> = {
  market: 'Market',
  portfolio: 'Portfolio',
  campaign: 'Campaign',
  adgroup: 'Ad Group',
  target: 'Target',
}

export function ObjectNode({ data }: NodeProps) {
  const d = data as unknown as OpsNodeData
  const health = d.health ?? 'ok'
  const showCount = d.hasChildren && !d.expanded && typeof d.childCount === 'number' && d.childCount > 0
  return (
    <div className={`opsn opsn--${health}${d.selected ? ' opsn--sel' : ''}`}>
      <Handle type="target" position={Position.Left} className="opsn-h" />
      <div className="opsn-top">
        <span className="opsn-kind">{KIND_LABEL[d.kind] ?? d.kind}</span>
        <span className="opsn-top-r">
          {showCount && <span className="opsn-count">{d.childCount}</span>}
          {d.hasChildren && (
            <button
              type="button"
              className="opsn-exp nodrag"
              onClick={(e) => {
                e.stopPropagation()
                d.onToggle?.()
              }}
              aria-label={d.expanded ? 'Collapse' : 'Expand'}
            >
              {d.expanded ? '−' : '+'}
            </button>
          )}
        </span>
      </div>
      <div className="opsn-title">{d.name}</div>
      <div className="opsn-meta">
        <span className={`opsn-dot opsn-dot--${health}`} />
        <span>{typeof d.spend === 'number' ? `€${Math.round(d.spend).toLocaleString()}` : '—'}</span>
        {typeof d.acos === 'number' && <span>· {Math.round(d.acos * 100)}%</span>}
      </div>
      <Handle type="source" position={Position.Right} className="opsn-h" />
    </div>
  )
}
