import React from 'react'
import { createRoot } from 'react-dom/client'
import { CategoriesWorkspace } from '@/app/catalog/categories/CategoriesWorkspace'
import { Button } from '@/design-system/primitives'
import '@/design-system/styles/tokens-global.css'
import '@/design-system/styles/primitives.css'
import '@/design-system/styles/components.css'
import '@/design-system/styles/patterns.css'
import '@/design-system/styles/a11y.css'
import './style.css'
const params = new URLSearchParams(location.search)
createRoot(document.getElementById('root')!).render(<><div className="qa-bar"><span>Isolated category QA · 10,000 product memberships</span><Button size="xs" onClick={() => document.documentElement.classList.toggle('dark')}>Toggle theme</Button><Button size="xs" onClick={() => void fetch('/api/pim/fixture/conflict',{method:'POST'})}>Conflict on next save</Button></div><main id="main-content"><CategoriesWorkspace initialView={params.get('view') ?? undefined} initialChannel={params.get('channel') ?? 'EBAY'} initialMarket={params.get('market') ?? 'IT'} /></main></>)
