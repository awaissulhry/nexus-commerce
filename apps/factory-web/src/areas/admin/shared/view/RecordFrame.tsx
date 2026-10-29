'use client'

import { useEffect, type ReactNode } from 'react'
import Link from 'next/link'
import { MessageSquare } from 'lucide-react'
import { Tabs, type TabItem } from '@nexus/ui/components'
import { DetailHeader } from '@nexus/ui/patterns'
import { Button, Kbd } from '@nexus/ui/primitives'
import { useT } from '../../../../lib/i18n/provider'

export interface RecordTab {
  id: string
  label: string
  /** Null draws nothing (unknown), 0 is an answer. */
  count?: number | null
}

/**
 * The record frame of an Admin record (design 02 shell.panels; Owner L1: the record's tabs always in view): ‹ back (a
 * real link to the list), the record's name, its identity, its state, at most two actions; then the record's sections
 * as link tabs (`?tab=`), with counts. The Office shell's band above holds the page's place; the shell has no slot for
 * a record's band yet (`usePageBand`, 00 §6.3), so the record draws its head at the top of the page with the DS
 * DetailHeader in its two-row form: the dense one-row form never wraps (a page band of a fixed height), which cuts the
 * name and the actions on a phone outside the WorkspaceSubheader.
 *
 * Owner O1: on a wide screen (1280 px and wider) the record's thread can stay beside any tab — the thread button or ⌘J
 * (Ctrl J) toggles it; narrower, the button opens the Activity tab. The container decides which (it knows the width)
 * and remembers the choice per record type on this device.
 */
export function RecordFrame({
  back,
  title,
  meta,
  status,
  actions,
  tabs,
  active,
  tabHref,
  dock,
  dockOpen,
  onDock,
  children,
}: {
  back: { href: string; label: string }
  title: ReactNode
  meta?: ReactNode
  status?: ReactNode
  actions?: ReactNode
  tabs: readonly RecordTab[]
  active: string
  /** The address of a tab (`?tab=<id>`). */
  tabHref: (tab: string) => string
  /** The thread beside the tab (the record panels); absent: no thread on this record. */
  dock?: ReactNode
  dockOpen?: boolean
  onDock?: () => void
  children?: ReactNode
}) {
  const t = useT('admin')
  useEffect(() => {
    if (!dock || !onDock) return
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'j') {
        event.preventDefault()
        onDock()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [dock, onDock])

  const items: TabItem[] = tabs.map((tab) => ({ id: tab.id, label: tab.label, count: tab.count, href: tabHref(tab.id) }))
  const showDock = !!dock && !!dockOpen

  return (
    <div className="fw-adm-record">
      <div className="fw-adm-band">
        <DetailHeader
          backAsChild
          backLabel={<Link href={back.href}>{back.label}</Link>}
          title={title}
          meta={meta}
          status={status}
          actions={
            <>
              {actions}
              {dock && (
                <Button size="sm" variant={dockOpen ? 'tonal' : 'secondary'} active={dockOpen} aria-pressed={dockOpen} onClick={() => onDock?.()} title={t('record.dockHint')}>
                  <MessageSquare size={14} aria-hidden /> {t('record.dock')}
                  <span className="fw-adm-dock-keys" aria-hidden>
                    <Kbd>⌘</Kbd>
                    <Kbd>J</Kbd>
                  </span>
                </Button>
              )}
            </>
          }
        />
        <Tabs ariaLabel={t('record.tabsLabel')} tabs={items} active={active} size="sm" overflow="scroll" />
      </div>
      <div className={showDock ? 'fw-adm-record-body has-dock' : 'fw-adm-record-body'}>
        <div className="fw-adm-record-main">{children}</div>
        {showDock && (
          <aside className="fw-adm-record-dock" aria-label={t('record.dockLabel')}>
            {dock}
          </aside>
        )}
      </div>
    </div>
  )
}
