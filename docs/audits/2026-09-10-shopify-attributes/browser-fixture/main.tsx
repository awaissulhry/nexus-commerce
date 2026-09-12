import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Button, Select } from '@/design-system/primitives'
import { Banner } from '@/design-system/components'
import { ShopifyInformationGrid } from '@/app/products/[id]/edit/_studio/shopify/ShopifyInformationGrid'
import { useLiveShopifySchema } from '@/app/products/[id]/edit/_studio/shopify/useLiveShopifySchema'
import { useListingEvents } from '@/lib/sync/use-listing-events'
import { emptyShopifyLinkedDraft } from '@nexus/shared/shopify-linked-products'
import '@/design-system/styles/tokens-global.css'
import '@/design-system/styles/primitives.css'
import '@/design-system/styles/components.css'
import '@/design-system/styles/patterns.css'
import '@/design-system/styles/a11y.css'
import './style.css'

function Sheet({ account }: { account: string }) {
  const path = `/api/products/verification/shopify-linked?accountId=${account}&market=GLOBAL`
  const { schema, error } = useLiveShopifySchema(path, true)
  const [draft, setDraft] = useState(emptyShopifyLinkedDraft())
  return <><p role="status">{account} · {schema?.definitions.length ?? 0} store definitions · {draft.edits.length} pending metafield edits</p>{error && <Banner tone="warning">{error}</Banner>}
    {schema && <ShopifyInformationGrid path={path} schema={schema} draft={draft} revision="saved-1" refreshToken={0} disabled={!!error} canPublish={false} onChange={setDraft} onManageContent={() => {}} />}</>
}
function Verification() {
  const [account, setAccount] = useState('store-A')
  const { connected } = useListingEvents(true)
  const command = (action: string) => fetch('/fixture/change', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, account }) })
  return <main><h1>Shopify attribute synchronization verification</h1><p>Synthetic store data. Uses the production grid, definition reader and event stream consumer.</p><div className="qa-controls">
    <Select size="sm" aria-label="Verification store" value={account} onChange={e => setAccount(e.target.value)}><option value="store-A">Store A</option><option value="store-B">Store B</option></Select>
    {['Add definition', 'Rename definition', 'Delete definition', 'Change other store', 'Fail schema read', 'Recover schema read'].map(action => <Button size="sm" key={action} onClick={() => { void command(action) }}>{action}</Button>)}
    <Button size="sm" onClick={() => document.documentElement.classList.toggle('dark')}>Toggle test theme</Button><span role="status">{connected ? 'Event stream connected' : 'Connecting event stream'}</span>
  </div><Sheet key={account} account={account} /></main>
}
createRoot(document.getElementById('root')!).render(<Verification />)
