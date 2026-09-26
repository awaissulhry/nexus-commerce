'use client'

/**
 * CHMAP — the two views of `/channels/mapping`, switched by `?view=`.
 *
 *   Push rules     (no `view`)      today's per-field rules that shape what a push SENDS (unchanged)
 *   File mappings  (`view=files`)   the versioned column decisions channel FILES are read and written with
 *
 * One page with a view switch, not a second page — the Owner's rule is "extend, don't add pages". The
 * switch keeps every other query parameter, so a return to Push rules lands on the channel, market and
 * category it left; only `set` (the File mappings selection) is dropped when leaving that view.
 */
import type { ReactNode } from 'react'
import { useRouter, useSearchParams } from '@/lib/workspaces/navigation'
import { Tabs } from '@/design-system/components'
import { FileMappingsView } from './FileMappingsView'
import { mappingViewHref, readMappingView, type MappingView } from './urls'
import styles from './files.module.css'

const VIEW_TABS = [
  { id: 'rules', label: 'Push rules' },
  { id: 'files', label: 'File mappings' },
]

function ViewTabs({ active }: { active: MappingView }) {
  const router = useRouter()
  const search = useSearchParams()
  return (
    <div className={styles.viewTabs}>
      <Tabs
        ariaLabel="Mapping views"
        size="lg"
        tabs={VIEW_TABS}
        active={active}
        onChange={id => { if (id !== active) router.replace(mappingViewHref(search.toString(), id as MappingView), { scroll: false }) }}
      />
    </div>
  )
}

export function MappingViews({ renderRules }: { renderRules: (viewTabs: ReactNode) => ReactNode }) {
  const search = useSearchParams()
  const view = readMappingView(search.get('view'))
  const tabs = <ViewTabs active={view} />
  return <>{view === 'files' ? <FileMappingsView viewTabs={tabs} /> : renderRules(tabs)}</>
}
