/**
 * CHMAP — the Mapping page's URL state for the view switch and the File mappings selection.
 * Deep link: `/channels/mapping?view=files&set=<id>`. Pure, so the round trips are tested.
 */
export type MappingView = 'rules' | 'files'

export const readMappingView = (value: string | null | undefined): MappingView => (value === 'files' ? 'files' : 'rules')

/** The page address for a view, keeping every other parameter; `set` belongs to File mappings only. */
export function mappingViewHref(currentQuery: string, view: MappingView): string {
  const next = new URLSearchParams(currentQuery)
  next.delete('view')
  next.delete('set')
  if (view === 'files') next.set('view', 'files')
  const query = next.toString()
  return `/channels/mapping${query ? `?${query}` : ''}`
}

/** The File mappings address with one version selected (or none). */
export function fileSetHref(currentQuery: string, setId: string | null): string {
  const next = new URLSearchParams(currentQuery)
  next.set('view', 'files')
  if (setId) next.set('set', setId)
  else next.delete('set')
  return `/channels/mapping?${next.toString()}`
}
