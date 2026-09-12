'use client'

import { useState } from 'react'
import { AsyncListboxPanel, Modal } from '@/design-system/components'
import { Button } from '@/design-system/primitives'
import { useProfileDirectory } from '@/lib/workspaces/profile-directory'
import type { BusinessProfile } from './ProfileScope'
import styles from './BusinessProfilePicker.module.css'

/** Shared business search used by navigation and account assignment; data stays in the feature. */
export function BusinessProfilePicker({ title = 'Choose business profile', value, permission, excludeId, onSelect, onClose }: {
  title?: string
  value?: string
  permission?: 'connect' | 'owner'
  excludeId?: string
  onSelect: (profile: BusinessProfile) => void
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const directory = useProfileDirectory({ q: query, permission })
  return <Modal open title={title} onClose={onClose} size="md" readable>
    <AsyncListboxPanel label="Search business profiles" query={query} onQueryChange={value => setQuery(value.slice(0, 80))}
      options={directory.profiles.filter(profile => profile.id !== excludeId).map(profile => ({ value: profile.id, label: profile.name, trailing: profile.roleNames.join(' · ') }))}
      value={value} loading={directory.loading} error={directory.error ?? undefined}
      emptyMessage={permission ? 'No profiles with the required access match your search.' : 'No profiles match your search.'}
      onRetry={directory.refresh} onCancel={onClose} onCommit={id => {
        const profile = directory.profiles.find(item => item.id === id)
        if (profile && profile.id !== excludeId && !directory.loading && !directory.error) onSelect(profile)
      }} style={{ width: '100%' }} />
    {(directory.page > 1 || directory.nextCursor) && <nav aria-label="Profile result pages" className={styles.pages}>
      <Button size="sm" disabled={directory.loading || directory.page === 1} onClick={directory.previous}>Previous</Button>
      <span>Page {directory.page}</span>
      <Button size="sm" disabled={directory.loading || !directory.nextCursor} onClick={directory.next}>Next</Button>
    </nav>}
  </Modal>
}
