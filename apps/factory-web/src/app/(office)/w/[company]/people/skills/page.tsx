import type { Metadata } from 'next'
import { Suspense } from 'react'
import { SkillsPage } from '../../../../../../areas/people/skills/SkillsPage'

export const metadata: Metadata = { title: 'Skills & training · Nexus Factory' }

/**
 * People › Skills & training (SCR-160; areas/people/nav.ts, permission people.skills.view): the matrix of skills and machine
 * authorisations of the top bar's site. The client container reads `?tile=`, `?show=`, `?sort=`, `?line=`, `?team=`, `?q=`.
 */
export default function PeopleSkillsPage() {
  return (
    <Suspense>
      <SkillsPage />
    </Suspense>
  )
}
