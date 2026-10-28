import { DesignGallery } from '../_parts/DesignGallery'
import { frameOptions } from '../_parts/frame-options'

type Search = Promise<Record<string, string | string[] | undefined>>

/** `/design/SCR-003` — every case of one screen (dev only). */
export default async function DesignScreenPage({ params, searchParams }: { params: Promise<{ screen: string }>; searchParams: Search }) {
  const [{ screen }, search] = await Promise.all([params, searchParams])
  const themes = search.themes === 'light' || search.themes === 'dark' ? search.themes : 'both'
  return <DesignGallery screenId={decodeURIComponent(screen)} initial={{ ...frameOptions(search), themes }} />
}
