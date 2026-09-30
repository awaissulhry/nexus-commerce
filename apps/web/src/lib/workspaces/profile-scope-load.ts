import type { BusinessProfile } from '@/app/_shared/ProfileScope'
import type { ProfileDirectoryPage } from './profile-directory'

/** The directory and detail endpoints return the same profile summary. */
export async function loadProfileScope(id: string | null, reads: {
  page: () => Promise<ProfileDirectoryPage>
  detail: (id: string) => Promise<BusinessProfile>
}) {
  let profiles: BusinessProfile[] = []
  let hasMore = false
  let error: string | null = null
  try {
    const page = await reads.page()
    profiles = page.workspaces
    hasMore = !!page.nextCursor
  } catch (cause) {
    error = cause instanceof Error ? cause.message : 'Business profiles could not be loaded.'
  }
  let selected = id ? profiles.find(profile => profile?.id === id) ?? null : null
  // A missing page must not hide a current profile that can still be verified independently.
  if (id && !selected) {
    try {
      const detail = await reads.detail(id)
      if (detail?.id !== id) throw new Error('The selected profile could not be verified.')
      selected = detail
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'The selected profile is unavailable.'
    }
  }
  return { profiles, selected, hasMore, error }
}
