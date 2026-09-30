'use client'

/** P1 (issue #15) — Customise's list of the family attributes with no column on this sheet, grouped by where they live. */
import { Disclosure } from '@/design-system/components'
import type { FamilyElsewhere } from './familyPlaces'

export function FamilyAttributesElsewhere({ state }: { state: FamilyElsewhere | 'loading' | 'error' | null }) {
  if (state === null) return null
  if (state === 'loading') return <p className="ps-family-elsewhere-note">Reading the family’s attributes…</p>
  if (state === 'error') return <p className="ps-family-elsewhere-note">The family’s attributes could not be read. Close and open Customise to try again.</p>
  if (!state.family) return <p className="ps-family-elsewhere-note">This product has no family: every attribute it holds is a column here.</p>
  const elsewhere = state.total - state.here
  return (
    <section className="ps-family-elsewhere" aria-label="Family attributes not on this sheet">
      <p className="ps-family-elsewhere-note">
        {`${state.family}: ${state.total} attributes — ${state.here} ${state.here === 1 ? 'is a column' : 'are columns'} here${elsewhere ? `, ${elsewhere} ${elsewhere === 1 ? 'lives' : 'live'} elsewhere` : ''}.`}
      </p>
      {state.groups.map(group => (
        <Disclosure key={group.where} summary={`${group.where} · ${group.labels.length}`}>
          <p className="ps-family-elsewhere-names">{group.labels.join(', ')}</p>
        </Disclosure>
      ))}
    </section>
  )
}
