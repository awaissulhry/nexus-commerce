'use client'

import { useState } from 'react'
import { Building2, ChevronDown, Plus, Search, Settings, User } from 'lucide-react'
import { Menu } from '@/design-system/components'
import { useAuth } from '@/lib/auth/AuthProvider'
import { WORKSPACES_ENABLED, workspaceSwitchPath } from '@/lib/workspaces/paths'
import { usePathname } from '@/lib/workspaces/navigation'
import styles from './ProfileSwitcher.module.css'
import { useProfileScope } from './ProfileScope'
import { navigateBusinessProfile } from '@/lib/workspaces/unsaved-changes'
import { BusinessProfilePicker } from './BusinessProfilePicker'

/** Business selection is an actual navigation; opening another tab retains the source tab. */
export function ProfileSwitcher() {
  const { status, user } = useAuth()
  const section = workspaceSwitchPath(usePathname())
  const { profiles, activeProfile, loaded, error, hasMore, refresh } = useProfileScope()
  const [searching, setSearching] = useState(false)
  if (status !== 'authed' || !user) return null
  if (!WORKSPACES_ENABLED) return <Menu label={<><User size={15} aria-hidden />{user.displayName || user.email}</>} align="right" items={[{ id: 'personal', label: 'Personal settings', href: '/settings/profile', description: user.email }]} />
  return <><Menu
    label={<><Building2 size={15} aria-hidden /><span className={styles.name}>{activeProfile?.name ?? (loaded ? 'Business profiles' : 'Loading profiles…')}</span><ChevronDown size={14} aria-hidden /></>}
    align="right"
    selectedId={activeProfile?.id}
    onNavigate={(event, item) => {
      if (event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && item.href) { event.preventDefault(); navigateBusinessProfile(item.href) }
    }}
    triggerProps={{ 'aria-label': `Business profile: ${activeProfile?.name ?? 'Choose a profile'}` }}
    items={[
      ...(error ? [{ id: 'retry', label: 'Retry loading profiles', description: error, onSelect: () => { void refresh() } }] : []),
      ...(activeProfile && !profiles.some(profile => profile.id === activeProfile.id) ? [{ id: activeProfile.id, label: activeProfile.name, description: 'Current profile', href: `/w/${activeProfile.id}${section}` }] : []),
      ...profiles.map(profile => ({ id: profile.id, label: profile.name, description: profile.roleNames.join(' · '), href: `/w/${profile.id}${section}` })),
      { id: 'search', label: hasMore ? 'Search all profiles…' : 'Search profiles…', icon: <Search size={15} aria-hidden />, onSelect: () => setSearching(true) },
      { id: 'divider', separator: true },
      { id: 'create', label: 'Create business profile', icon: <Plus size={15} aria-hidden />, href: '/profiles?create=1' },
      { id: 'manage', label: 'Manage business profiles', icon: <Settings size={15} aria-hidden />, href: '/profiles' },
      { id: 'personal', label: 'Personal settings', description: user.email, icon: <User size={15} aria-hidden />, href: '/settings/profile' },
    ]}
  />{searching && <BusinessProfilePicker value={activeProfile?.id} onClose={() => setSearching(false)} onSelect={profile => { setSearching(false); navigateBusinessProfile(`/w/${profile.id}${section}`) }} />}</>
}
export default ProfileSwitcher
