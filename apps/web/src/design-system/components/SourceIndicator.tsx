'use client'

import { Circle, Database, GitBranch, Link2, Pin, Settings2, Sparkles, FunctionSquare, AlertTriangle } from 'lucide-react'
import { Button } from '../primitives/Button'
import { Tooltip, useTooltipsDisabled } from '../primitives/Tooltip'

export type ValueSourceKind = 'master' | 'override' | 'rule' | 'default' | 'missing' | 'linked' | 'channel' | 'formula' | 'ai' | 'warning'

const ICONS = {
  master: Link2, override: Pin, rule: Settings2, default: Database, missing: Circle,
  linked: GitBranch, channel: Database, formula: FunctionSquare, ai: Sparkles, warning: AlertTriangle,
}

export interface SourceIndicatorProps {
  kind: ValueSourceKind
  label: string
  description: string
  /** Exact tooltip copy, including a native title when the host disables custom hints. */
  tooltip?: string
  /** An action is offered only when both its description and handler are present. */
  actionLabel?: string
  onAction?: () => void
  /** Labels stay visible in legends; dense cells use the same icon with a tooltip. */
  showLabel?: boolean
  /**
   * A routine source (a value that follows somewhere else) drawn in the muted text colour, so the cells that hold
   * their own value stand out on a dense sheet. Quieter, never hidden: the icon, its name and its action stay.
   */
  quiet?: boolean
  tabIndex?: number
}

/** A value's origin, with a hover/focus explanation that escapes scrolling grids. */
export function SourceIndicator({ kind, label, description, tooltip, actionLabel, onAction, showLabel = false, quiet = false, tabIndex = 0 }: SourceIndicatorProps) {
  const Icon = ICONS[kind]
  const actionable = !!onAction && !!actionLabel
  const explanation = [label, description, actionable ? actionLabel : null]
    .filter((part): part is string => !!part).map(part => part.trim().replace(/\.+$/, '')).join('. ')
  const content = <><Icon size={14} strokeWidth={2} aria-hidden="true" />{showLabel && <span>{label}</span>}</>
  const className = `nds-source-indicator${showLabel ? ' nds-source-indicator--label' : ''}${quiet ? ' nds-source-indicator--quiet' : ''}`
  // In a host without hints (a dense grid: one mark per cell) the Tooltip would render only its trigger: skip mounting it.
  const hintless = useTooltipsDisabled()
  const trigger = actionable ? (
    <Button
      inline variant="quiet" className={className} type="button"
      aria-label={explanation} title={tooltip} tabIndex={tabIndex} data-value-source={kind}
      onMouseDownCapture={(event) => event.stopPropagation()}
      onDoubleClickCapture={(event) => event.stopPropagation()}
      // AG handles native key events before React's bubble handlers; capture keeps Enter/Space on this action.
      onKeyDownCapture={(event) => { if (event.key === 'Enter' || event.key === ' ') event.stopPropagation() }}
      onClick={(event) => { event.stopPropagation(); onAction() }}
    >{content}</Button>
  ) : (
    <span className={className} role="img" aria-label={explanation} title={tooltip} tabIndex={tabIndex} data-value-source={kind}
      onKeyDownCapture={(event) => {
        if (event.key === 'Enter' || event.key === ' ') { event.stopPropagation(); event.preventDefault() }
      }}>
      {content}
    </span>
  )
  return hintless ? trigger : <Tooltip portal label={tooltip ?? explanation}>{trigger}</Tooltip>
}
