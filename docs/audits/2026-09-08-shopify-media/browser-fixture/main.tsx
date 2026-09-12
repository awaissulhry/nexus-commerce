import React from 'react'
import { createRoot } from 'react-dom/client'
import '@/design-system/styles/tokens-global.css'
import '@/design-system/styles/primitives.css'
import '@/design-system/styles/components.css'
import '@/design-system/styles/patterns.css'
import '@/design-system/styles/a11y.css'
import { MediaSourceLibrary } from '@/app/_shared/media/MediaSourceLibrary'
import { Button } from '@/design-system/primitives'
import { PageHeader } from '@/design-system/patterns'
import { MediaGalleryExample } from '@/design-system/catalog/MediaGalleryExample'
const params = new URLSearchParams(location.search)
document.documentElement.classList.toggle('dark', params.get('theme') === 'dark')
document.body.style.cssText = 'margin:0;background:var(--nds-bg);color:var(--nds-text);font-family:system-ui;font-size:13px;'
const width = Number(params.get('width')) || null
function App() {
  if (width && !params.has('embedded')) return <iframe title="Responsive media library" src={`/?${new URLSearchParams({ ...Object.fromEntries(params), embedded: '1' })}`} style={{ width, height: '95vh', border: 0 }} />
  return <main style={{ padding: '16px', maxWidth: 1200, margin: 'auto' }}>
    <PageHeader title="Media library" subtitle="Isolated Shopify media QA · synthetic files" />
    <MediaSourceLibrary imagesOnly={params.has('picker')} nexusLibrary={<p>Nexus assets remain available here.</p>} onUse={params.has('picker') ? async reference => { await fetch('/api/fixture/used', { method: 'POST', body: JSON.stringify(reference) }) } : undefined} />
    <p><Button asChild><a href={`/?${new URLSearchParams({ ...Object.fromEntries(params), theme: params.get('theme') === 'dark' ? 'light' : 'dark' })}`}>Switch theme</a></Button></p>
    {params.has('catalog') && <MediaGalleryExample />}
  </main>
}
createRoot(document.getElementById('root')!).render(<App />)
