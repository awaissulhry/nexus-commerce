import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ShopifyContentWorkspace } from '@/app/products/[id]/edit/_studio/images/shopify/ShopifyContentWorkspace'
import { Button } from '@/design-system/primitives'
import '@/design-system/styles/tokens-global.css'
import '@/design-system/styles/primitives.css'
import '@/design-system/styles/components.css'
import '@/design-system/styles/patterns.css'
import '@/design-system/styles/a11y.css'
function App() {
 const [mode,setMode]=useState('light')
 return <><div style={{padding:'var(--nds-space-16)',display:'flex',flexWrap:'wrap',gap:'var(--nds-space-16)',alignItems:'center',borderBottom:'1px solid var(--nds-border)'}}><strong>Nexus × Impact · Local review</strong><span>Sample data · Shopify writes simulated</span><Button size="sm" onClick={()=>{const next=mode==='light'?'dark':'light';setMode(next);document.documentElement.classList.toggle('dark',next==='dark')}}>Switch to {mode==='light'?'dark':'light'}</Button><a style={{color:'var(--nds-text)'}} href="/it/products/demo">Storefront preview</a></div><main><ShopifyContentWorkspace path="/api/products/family/shopify-content?accountId=fixture&market=GLOBAL" accountLabel="Xavia · Sample store" /></main></>
}
await navigator.serviceWorker.register('/mock-images-worker.js')
await navigator.serviceWorker.ready
if (!navigator.serviceWorker.controller) await new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }))
createRoot(document.getElementById('root')!).render(<App/> )
