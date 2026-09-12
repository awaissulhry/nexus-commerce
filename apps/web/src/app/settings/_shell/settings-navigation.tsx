import type { WorkspaceNavGroup } from '@/design-system/patterns/WorkspaceSubheader'
import { settingsNavPermission } from '@/lib/auth/nav-permissions'
import { withoutWorkspace, workspaceFromPath, workspaceHref } from '@/lib/workspaces/paths'
import { SETTINGS_NAV, findNavItemForPath } from './settings-nav'

/** Native drawer links retain the business profile when copied or opened in another tab. */
export function buildSettingsNavigation(
  pathname: string,
  hasPermission?: (permission: string) => boolean,
): WorkspaceNavGroup[] {
  const workspaceId = workspaceFromPath(pathname)
  const activeItem = findNavItemForPath(withoutWorkspace(pathname))

  return SETTINGS_NAV.map(group => ({
    id: group.label.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    label: group.label,
    collapsible: true,
    items: group.items.filter(item => {
      const permission = settingsNavPermission(item.href)
      return !hasPermission || permission === null || hasPermission(permission)
    }).map(item => {
      const Icon = item.icon
      return {
        id: item.href,
        href: workspaceHref(workspaceId, item.href),
        label: item.label,
        icon: <Icon size={16} aria-hidden />,
        active: activeItem?.href === item.href,
        badge: item.status === 'beta' ? 'Beta' : item.status === 'soon' ? 'Soon' : undefined,
      }
    }),
  })).filter(group => group.items.length > 0)
}
