'use client'

import { ChevronDown, ChevronRight } from 'lucide-react'
import { Button, Spinner } from '@nexus/ui/primitives'
import type { GroupMarker, ListGroup } from './model'

type Translate = (key: string, params?: Record<string, string | number>) => string

/**
 * B-TH-241: one full-width line of a grouped list frame — a group's header (the fold toggle, its name as a door, its figures from
 * the server, "—" while they are read), its "Show more of …" button, or its reading / failed line with Retry. The toggle is its own
 * button (the name is a link: a separate focus ring each).
 */
export function GroupLine({ marker, group, folded, onToggle, t }: { marker: GroupMarker; group: ListGroup | undefined; folded: boolean; onToggle: (key: string) => void; t: Translate }) {
  if (!group) return null
  if (marker.fwGroup === 'more' && group.more) {
    return (
      <div className="fw-list-group-line more">
        <Button size="sm" variant="quiet" onClick={group.more.onMore}>
          {group.more.label}
        </Button>
      </div>
    )
  }
  if (marker.fwGroup === 'state' && group.state) {
    return group.state.kind === 'reading' ? (
      <div className="fw-list-group-line state" role="status">
        <Spinner size={12} /> {t('groups.reading', { name: group.name })}
      </div>
    ) : (
      <div className="fw-list-group-line state failed" role="alert">
        <span>{group.state.words}</span>
        <Button size="sm" onClick={group.state.onRetry}>
          {t('groups.retry')}
        </Button>
      </div>
    )
  }
  if (marker.fwGroup !== 'header') return null
  return (
    <div className="fw-list-group-line header">
      <Button size="sm" variant="quiet" aria-expanded={!folded} aria-label={t(folded ? 'groups.show' : 'groups.hide', { name: group.name })} title={t(folded ? 'groups.show' : 'groups.hide', { name: group.name })} onClick={() => onToggle(group.key)}>
        {folded ? <ChevronRight size={14} aria-hidden /> : <ChevronDown size={14} aria-hidden />}
      </Button>
      <span className="fw-list-group-name">{group.label}</span>
      <span className="fw-list-group-sum">{group.summary ?? <span aria-label={t('groups.counting')}>—</span>}</span>
    </div>
  )
}
