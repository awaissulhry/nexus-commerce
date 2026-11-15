'use client'

import { useEffect } from 'react'
import { SegmentedControl, Select } from '@nexus/ui/primitives'
import { useT } from '../../../../../lib/i18n/provider'
import type { ListKey } from '../../../../../list-frame/model'
import type { CompanyChoice } from '../model'

/** The Documents page's lists (design admin.documents sec:views: Numbers · Documents · E-mails · Branding · Required documents). */
export type PageView = 'numbers' | 'documents' | 'mail' | 'branding' | 'required'

/**
 * The template lists' frame tools (B-W2b-432): which list of the Documents page (the same SegmentedControl and words as
 * its other lists) and which company — a template is one company's, so the list shows one company at a time.
 */
export function ViewSwitch({ view, companies, companyId, onView, onCompany }: { view: PageView; companies: readonly CompanyChoice[]; companyId: string | null; onView?: (view: PageView) => void; onCompany?: (companyId: string) => void }) {
  const td = useT('admin-documents')
  return (
    <>
      <SegmentedControl
        ariaLabel={td('docs.views.label')}
        size="sm"
        value={view}
        onChange={(value) => onView?.(value as PageView)}
        options={[
          { value: 'numbers', label: td('docs.views.numbers') },
          { value: 'documents', label: td('docs.views.documents') },
          { value: 'mail', label: td('docs.views.mail') },
          { value: 'branding', label: td('docs.views.branding') },
          { value: 'required', label: td('docs.views.required') },
        ]}
      />
      {companies.length > 1 && (
        <Select size="sm" aria-label={td('docs.company.label')} value={companyId ?? ''} onChange={(event) => onCompany?.(event.target.value)}>
          {companies.map((company) => (
            <option key={company.id} value={company.id}>
              {company.name}
            </option>
          ))}
        </Select>
      )}
    </>
  )
}

/** 1 / 2 / 3 / 5 / 6 switch the page's list (as on its other lists); never while typing or in a dialog. */
export function usePageViewKeys(onView: ((view: PageView) => void) | undefined, paused: boolean) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (paused || event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target as HTMLElement | null
      if (target && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.closest('[role="dialog"]'))) return
      const view: PageView | null = event.key === '1' ? 'numbers' : event.key === '2' ? 'documents' : event.key === '3' ? 'mail' : event.key === '5' ? 'branding' : event.key === '6' ? 'required' : null
      if (!view) return
      event.preventDefault()
      onView?.(view)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onView, paused])
}

/** Those keys, for the list footer's info icon (never above the table). */
export function usePageViewKeyList(): ListKey[] {
  const td = useT('admin-documents')
  return [
    { keys: ['1'], does: td('docs.keys.numbers') },
    { keys: ['2'], does: td('docs.keys.documents') },
    { keys: ['3'], does: td('docs.keys.mail') },
    { keys: ['5'], does: td('docs.keys.branding') },
    { keys: ['6'], does: td('docs.keys.required') },
  ]
}
