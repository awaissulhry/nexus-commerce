import type { Metadata } from 'next'
import { MePage } from '../../../../../areas/me/MePage'

export const metadata: Metadata = { title: 'Nexus Factory' }

/** `/w/<company>/me` — my profile & security (SCR-007; the page lives in areas/me). */
export default function Page({ params }: { params: Promise<{ company: string }> }) {
  return <MePage params={params} />
}
