import React, { Component, StrictMode, useState } from 'react'
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
const diagnostics: string[] = []
for (const level of ['warn', 'error'] as const) {
  const original = console[level].bind(console)
  console[level] = (...args: unknown[]) => {
    const message = args.map(String).join(' ')
    diagnostics.push(`${level}: ${message}`)
    original(...args)
    document.getElementById('qa-diagnostics')?.replaceChildren(document.createTextNode(diagnostics.join('\n')))
  }
}
class Boundary extends Component<React.PropsWithChildren, { error: string | null }> {
  state = { error: null as string | null }
  static getDerivedStateFromError(error: Error) { return { error: error.stack ?? error.message } }
  render() { return this.state.error ? <div role="alert">QA caught rendering failure: {this.state.error}</div> : this.props.children }
}
function App() {
  const [armed, setArmed] = useState(false)
  return <><div className="qa-bar"><span>Grid lifecycle QA</span>
    <Button size="xs" variant="secondary" onClick={() => document.documentElement.classList.toggle('dark')}>Toggle theme</Button>
    <Button size="xs" variant="secondary" onClick={async () => { await fetch('/api/fixture/fail-next-read', { method: 'POST' }); setArmed(true) }}>Fail next sheet read</Button>
    <span>{armed ? 'Next read armed; use More → Reload, then Try again.' : 'Ready'}</span></div>
    <Boundary><main id="main-content"><StudioClient product={product} family={null} marketplaces={marketplaces} marketplacesFailed={false} /></main></Boundary>
    <details open><summary>Browser warnings and errors</summary><pre id="qa-diagnostics" /></details></>
}
createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)
