'use client'

/**
 * TB.6 — the profile control in the top bar, replacing the connected-accounts chip.
 *
 * Shows who is signed in and which PROFILE (schema: `Role`) their view is scoped to, and lets
 * them switch it. Built on the DS `Menu` primitive — no hand-rolled dropdown, no second
 * click-away/positioning implementation.
 *
 * 🔴 The menu states what a switch does and does not do. Selecting a profile narrows what you
 * SEE; the server still enforces the union of your role assignments (see ProfileScope.tsx for
 * why that asymmetry is the safe direction and the only honest one available today). A control
 * that implied it changed access would be a lying UI.
 */

import { Menu } from '@/design-system/components'
import { useAuth } from '@/lib/auth/AuthProvider'
import { useProfileScope } from './ProfileScope'
import { Check, ShieldCheck, User } from 'lucide-react'

/** "Awais Sulhry" → "AS"; falls back to the email's first letter. */
function initials(displayName: string, email: string): string {
  const parts = displayName.trim().split(/\s+/).filter(Boolean)
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
  if (parts.length === 1 && parts[0].length > 0) return parts[0].slice(0, 2).toUpperCase()
  return (email.trim()[0] || '?').toUpperCase()
}

export function ProfileSwitcher() {
  const { status, user } = useAuth()
  const { profiles, activeKey, activeProfile, setActiveKey, canSwitch, loaded } = useProfileScope()

  // Anonymous (shadow mode / pre-enforce) has no identity to show. Render nothing rather than a
  // control with placeholder text — an empty chip in the chrome reads as a broken session.
  if (status !== 'authed' || !user) return null

  const scopeLabel = activeProfile ? activeProfile.name : 'All access'

  const items = [
    {
      id: 'identity',
      label: (
        <span className="nds-topbar-profile-identity">
          <span className="nm">{user.displayName || user.email}</span>
          <span className="sub">{user.email}</span>
        </span>
      ),
      disabled: true,
    },
    { id: 'sep-1', separator: true },
    {
      id: 'scope-head',
      label: <span className="nds-topbar-profile-head">View as profile</span>,
      disabled: true,
    },
    {
      id: 'all',
      icon: activeKey === null ? <Check size={14} /> : <span style={{ width: 14 }} />,
      label: (
        <span className="nds-topbar-profile-row">
          <span className="nm">All access</span>
          <span className="sub">Everything your assignments allow</span>
        </span>
      ),
      onSelect: () => setActiveKey(null),
    },
    ...profiles.map((p) => ({
      id: p.key,
      icon: activeKey === p.key ? <Check size={14} /> : <span style={{ width: 14 }} />,
      label: (
        <span className="nds-topbar-profile-row">
          <span className="nm">{p.name}</span>
          <span className="sub">
            {p.isOwner ? 'Full access' : `${p.permissions.length} permissions`}
            {p.memberCount > 0 ? ` · ${p.memberCount} member${p.memberCount === 1 ? '' : 's'}` : ''}
          </span>
        </span>
      ),
      onSelect: () => setActiveKey(p.key),
    })),
    { id: 'sep-2', separator: true },
    {
      id: 'note',
      label: (
        <span className="nds-topbar-profile-note">
          Changes what you see, not what you can do — the server still enforces every profile
          you&rsquo;re assigned.
        </span>
      ),
      disabled: true,
    },
  ]

  // Nothing a selection could change (one profile, or the roster is not readable by this
  // session): render the identity informationally. MAP.4's rule — a dropdown that cannot change
  // anything is worse than no dropdown.
  if (loaded && !canSwitch) {
    return (
      <span className="nds-topbar-profile nds-topbar-profile-static" title={user.email}>
        <span className="nds-topbar-avatar" aria-hidden="true">
          {initials(user.displayName, user.email)}
        </span>
        <span className="nds-topbar-profile-name">{user.displayName || user.email}</span>
      </span>
    )
  }

  return (
    <Menu
      align="right"
      className="nds-topbar-profile-menu"
      triggerProps={{
        /* `triggerProps` spreads AFTER the DS's own `className="nds-btn"`, so passing a bare
           class REPLACES the primitive rather than extending it. Both are named explicitly. */
        className: 'nds-btn nds-topbar-profile',
        'aria-label': `Profile: ${scopeLabel}`,
      }}
      label={
        <>
          <span className="nds-topbar-avatar" aria-hidden="true">
            {initials(user.displayName, user.email)}
          </span>
          <span className="nds-topbar-profile-name">{scopeLabel}</span>
          {activeProfile ? (
            <ShieldCheck size={13} className="nds-topbar-profile-scoped" aria-hidden="true" />
          ) : (
            <User size={13} className="nds-topbar-profile-scoped" aria-hidden="true" />
          )}
        </>
      }
      items={items}
    />
  )
}

export default ProfileSwitcher
