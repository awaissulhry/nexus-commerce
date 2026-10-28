import { DesignFrame } from '../../_parts/DesignFrame'
import { frameOptions } from '../../_parts/frame-options'

type Search = Promise<Record<string, string | string[] | undefined>>

/** `/design/SCR-003/owner?theme=dark&lang=it` — one fixture, alone (dev only). */
export default async function DesignFixturePage({ params, searchParams }: { params: Promise<{ screen: string; fixture: string }>; searchParams: Search }) {
  const [{ screen, fixture }, search] = await Promise.all([params, searchParams])
  return <DesignFrame screenId={decodeURIComponent(screen)} caseId={decodeURIComponent(fixture)} options={frameOptions(search)} />
}
