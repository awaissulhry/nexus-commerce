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
const product = { id: 'store-demo', sku: 'TRAVEL-BAG', name: 'Canvas travel bag', status: 'DRAFT', isParent: true, parentId: null, productType: null, asin: null }
const marketplaces = ['SHOPIFY', 'ETSY'].map(channel => ({ id: channel, channel, code: 'GLOBAL', name: channel === 'SHOPIFY' ? 'Shopify' : 'Etsy', language: 'en', connected: true, accounts: [{ id: channel.toLowerCase(), label: `${channel === 'SHOPIFY' ? 'Shopify' : 'Etsy'} demo store`, primary: true }] }))
createRoot(document.getElementById('root')!).render(<><div className="qa-bar"><span>Isolated product information QA</span><Button size="xs" variant="secondary" onClick={() => document.documentElement.classList.toggle('dark')}>Toggle theme</Button></div><main id="main-content"><StudioClient product={product} family={null} marketplaces={marketplaces} marketplacesFailed={false} /></main></>)
