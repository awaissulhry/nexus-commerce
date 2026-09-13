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
const {product,marketplaces} = await (await fetch('/api/fixture/info')).json()
createRoot(document.getElementById('root')!).render(<><div className="qa-bar"><span>XAVIA GALE · local development database · language write rehearsal</span><Button size="xs" variant="secondary" onClick={() => document.documentElement.classList.toggle('dark')}>Toggle theme</Button></div><main id="main-content"><StudioClient product={product} family={null} marketplaces={marketplaces} marketplacesFailed={false} /></main></>)
