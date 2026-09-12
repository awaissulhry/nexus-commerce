import React from 'react'
import { createRoot } from 'react-dom/client'
import { StudioClient } from '@/app/products/[id]/edit/_studio/StudioClient'
import { Button } from '@/design-system/primitives'
import '@/design-system/styles/tokens-global.css'
import '@/design-system/styles/primitives.css'
import '@/design-system/styles/components.css'
import '@/design-system/styles/patterns.css'
import '@/design-system/styles/a11y.css'
import './style.css'
const product = { id: 'store-demo', sku: 'INFO-JACKET', name: 'Information jacket', status: 'DRAFT', isParent: true, parentId: null, productType: null, asin: null }
const marketplaces = ['AMAZON', 'EBAY', 'ETSY', 'SHOPIFY'].map(channel => ({ id: channel, channel, code: ['ETSY', 'SHOPIFY'].includes(channel) ? 'GLOBAL' : 'IT', name: channel, language: ['ETSY', 'SHOPIFY'].includes(channel) ? 'en' : 'it', connected: true, accounts: ['a', 'b'].map(suffix => ({ id: `${channel.toLowerCase()}-${suffix}`, label: `${channel} store ${suffix.toUpperCase()}`, primary: suffix === 'a' })) }))

createRoot(document.getElementById('root')!).render(<><div className="qa-bar"><span>Disposable Information fixture</span><Button size="xs" onClick={() => { void fetch("/api/fixture/mode", { method: "POST", body: JSON.stringify({ mode: "interrupt" }) }) }}>Interrupt next save</Button><Button size="xs" onClick={() => { void fetch("/api/fixture/mode", { method: "POST", body: JSON.stringify({ mode: "delay" }) }) }}>Delay next read</Button><Button size="xs" variant="secondary" onClick={() => document.documentElement.classList.toggle('dark')}>Toggle theme</Button></div><main id="main-content"><StudioClient product={product} family={null} marketplaces={marketplaces} marketplacesFailed={false} /></main></>)
