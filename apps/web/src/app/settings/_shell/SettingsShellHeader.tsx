'use client'

import { useEffect, useRef, useState, type MouseEvent } from 'react'
import { usePathname } from 'next/navigation'
import { Search } from 'lucide-react'
import { DetailHeader, WorkspaceSubheader, type WorkspaceNavItem, type WorkspaceSubheaderProps } from '@/design-system/patterns'
import { ToolbarButton } from '@/design-system/primitives'
import { useAuth } from '@/lib/auth/AuthProvider'
import Link from '@/lib/workspaces/Link'
import { useRouter } from '@/lib/workspaces/navigation'
import { withoutWorkspace } from '@/lib/workspaces/paths'
import { findGroupForPath, findNavItemForPath } from './settings-nav'
import { buildSettingsNavigation } from './settings-navigation'
import { useSettingsPalette } from './SettingsPaletteContext'
import styles from './settings-shell.module.css'

export function SettingsShellHeader() {
  const pathname = usePathname() ?? '/settings'
  const item = findNavItemForPath(withoutWorkspace(pathname))
  const group = findGroupForPath(withoutWorkspace(pathname))
  const router = useRouter()
  const { status, has } = useAuth()
  const { open: openPalette } = useSettingsPalette()
  const headerRef = useRef<HTMLElement>(null)
  const [chrome, setChrome] = useState<WorkspaceSubheaderProps['chrome']>()

  useEffect(() => {
    setChrome({
      header: document.querySelector<HTMLElement>('.nds-topbar'),
      primaryNavigation: headerRef.current?.closest('.app-rail-host')?.querySelector<HTMLElement>('.h10-rail') ?? null,
    })
  }, [])

  const navigate = (event: MouseEvent<HTMLAnchorElement>, destination: WorkspaceNavItem) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    router.push(destination.href)
  }

  return (
    <header ref={headerRef} className={styles.header}>
      <WorkspaceSubheader
        chrome={chrome}
        navigationLabel="Settings navigation"
        groups={buildSettingsNavigation(pathname, status === 'authed' ? has : undefined)}
        onNavigate={navigate}
        header={
          <DetailHeader
            dense
            backAsChild={!!item}
            backLabel={<Link href="/settings">Settings</Link>}
            title={item?.label ?? 'Settings'}
            meta={group?.label}
            actions={
              <ToolbarButton
                icon={<Search size={16} aria-hidden />}
                label="Find a setting"
                shortcut="⌘K / Ctrl+K"
                onClick={openPalette}
              />
            }
          />
        }
      />
    </header>
  )
}
