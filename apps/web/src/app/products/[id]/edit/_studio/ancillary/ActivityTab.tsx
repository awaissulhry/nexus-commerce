'use client'

/** Activity reads only explicitly attributed product/listing events. Audit access
 * remains with the audit log's existing permission boundary. */
import { useCallback, useEffect, useMemo, useState } from 'react'

import { Button, Pill } from '@/design-system/primitives'

import { Banner, ProgressBar } from '@/design-system/components'
import { useWorkspaceRead } from '../useWorkspaceRead'
import {
  groupEvents, readValue, summariseActivity, type EventKind, type ProductEvent,
} from './activity/readEvents'
import styles from './analytics.module.css'

const KIND_TONE: Record<EventKind, 'info' | 'success' | 'warning' | 'neutral'> = {
  images: 'info', import: 'neutral', bulk: 'warning', other: 'neutral',
}

interface ActivityPage { events: ProductEvent[]; nextCursor: string | null; coverageNote: string }

export function ActivityTab() {
  const [events, setEvents] = useState<ProductEvent[]>([])
  const [cursor, setCursor] = useState<string>()
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const read = useWorkspaceRead<ActivityPage>('activity', cursor ? new URLSearchParams({ cursor }).toString() : '')
  useEffect(() => {
    if (read.data) setEvents(previous => cursor ? [...previous, ...read.data!.events.filter(event => !previous.some(old => old.id === event.id))] : read.data!.events)
  }, [read.data, cursor])

  const groups = useMemo(() => groupEvents(events ?? []), [events])
  const summary = useMemo(() => summariseActivity(events ?? []), [events])

  const toggle = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }, [])

  return (
    <div className={styles.page}>
      <header className={styles.head}>
        <h2 className={styles.title}>Activity</h2>
        {summary.total > 0 && (
          <>
            <Pill tone="neutral">{summary.total} {summary.total === 1 ? 'event' : 'events'}</Pill>
            {summary.firstAt && (
              <span className={styles.unknown}>
                since {new Date(summary.firstAt).toLocaleDateString()}
              </span>
            )}
          </>
        )}
      </header>

      {read.loading && <ProgressBar indeterminate ariaLabel="Reading activity for the selected scope" />}
      {read.error && <Banner tone="danger">{read.error}</Banner>}
      {read.data && <Banner tone="neutral">{read.data.coverageNote}</Banner>}
      {!read.loading && !read.error && summary.total === 0 && <p className={styles.state}>No attributed activity has been recorded in this scope.</p>}

      {groups.length > 0 && (
        <section className={styles.card}>
          {groups.map((group) => {
            const r = group.reading
            const open = expanded.has(group.id)
            return (
              <div key={group.id} className={styles.eventRow}>
                <div className={styles.eventMain}>
                  <Pill tone={KIND_TONE[r.kind]}>{r.title}</Pill>
                  {/* A group states its own size — summarising, not dropping. */}
                  {group.grouped && (
                    <span className={styles.unknown}>{group.events.length} events</span>
                  )}
                  {r.detail && <span className={styles.eventDetail}>{r.detail}</span>}
                  {r.actor && <span className={styles.unknown}>{r.actor}</span>}
                  <span className={styles.spacer} />
                  <span className={styles.eventWhen}>
                    {new Date(group.at).toLocaleString()}
                  </span>
                  {/* Offered only where there is something behind it. */}
                  {r.fields && (
                    <Button size="sm" variant="ghost" onClick={() => toggle(group.id)}>
                      {open ? 'Hide' : `${r.fields.length} change${r.fields.length === 1 ? '' : 's'}`}
                    </Button>
                  )}
                </div>
                {open && r.fields && (
                  /*
                   * 🔴 A description list, not a grid and not a table.
                   *
                   * This is one or two field→value pairs inside an expanded row — a property list,
                   * which `<dl>` is the semantic element for. The programme rule that grid chrome
                   * lives in the engine is about GRIDS: there is nothing here to sort, filter,
                   * virtualise or customise, and mounting an AG instance per expanded row would put
                   * several on screen at once to render four words. It also counts against neither
                   * arm of `check-grid-kit-ratchet`, so this is not a way around the gate — the
                   * gate is green either way.
                   */
                  <dl className={styles.delta}>
                    {r.fields.map((f) => (
                      <div key={f.field}>
                        <dt>{f.field}</dt>
                        <dd className={f.value === null ? styles.unknown : undefined}>
                          {readValue(f.value)}
                        </dd>
                      </div>
                    ))}
                  </dl>
                )}
              </div>
            )
          })}
        </section>
      )}

      {read.data?.nextCursor && <Button disabled={read.loading} onClick={() => setCursor(read.data!.nextCursor!)}>Load earlier activity</Button>}
    </div>
  )
}
