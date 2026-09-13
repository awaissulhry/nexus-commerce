import React from 'react'
import { createRoot } from 'react-dom/client'
import { PublishMenu } from '@/app/products/[id]/edit/_studio/PublishMenu'
import '@/design-system/styles/tokens-global.css'
import '@/design-system/styles/primitives.css'
import '@/design-system/styles/components.css'
import '@/design-system/styles/a11y.css'
const dark = new URLSearchParams(location.search).get('dark') === '1'
if (dark) document.documentElement.classList.add('dark')
document.body.style.cssText = 'margin:0;font-family:system-ui;background:var(--nds-bg);color:var(--nds-text)'
createRoot(document.getElementById('root')!).render(<main className={dark ? 'dark' : ''} style={{ padding: 24, minHeight: '100vh' }}><div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16 }}><div><h1 style={{ fontSize: 22 }}>Gale motorcycle jacket</h1><p>GALE-JACKET · Saved</p></div><PublishMenu /></div><p>Isolated product studio verification · provider calls are mocked.</p></main>)
