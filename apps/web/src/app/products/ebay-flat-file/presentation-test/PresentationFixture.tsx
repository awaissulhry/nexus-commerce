'use client'

import Link from '@/lib/workspaces/Link'
import { useSearchParams } from 'next/navigation'
import { Banner, Field, Listbox, ToastProvider } from '@/design-system/components'
import { Button } from '@/design-system/primitives'
import { StudioStateProvider, useStudioScope } from '@/app/products/[id]/edit/_studio/contracts'
import { PresentationTab } from '@/app/products/[id]/edit/_studio/PresentationTab'

const accounts = [{ id: 'a', label: 'Fixture account a', primary: true }, { id: 'b', label: 'Fixture account b', primary: false }]
const marketplaces = ['IT', 'DE'].map(code => ({ id: code, channel: 'EBAY', code, name: `eBay ${code}`, language: code === 'IT' ? 'it' : 'de', connected: true, accounts }))
export function PresentationFixture() {
  const search = useSearchParams(), id = search.get('product') === 'f2' ? 'f2' : 'f1'
  return <ToastProvider><StudioStateProvider key={id} product={{ id, sku: id.toUpperCase(), name: `Fixture family ${id}`, isParent: true, parentId: null, status: 'ACTIVE', productType: 'VARIATION', asin: null }} family={null} primaryLanguage="it" marketplaces={marketplaces}>
    <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', height: 'calc(100vh - 80px)' }}><FixtureScope /><PresentationTab /></div>
  </StudioStateProvider></ToastProvider>
}
function FixtureScope() {
  const { market, accountId, setMarket, setAccount } = useStudioScope()
  return <div style={{ padding: 'var(--nds-space-16)', display: 'flex', flexWrap: 'wrap', gap: 'var(--nds-space-8)' }}>
    <Banner tone="neutral">Isolated test catalog. Real Presentation component and Studio scope provider; mocked catalog and marketplace only.</Banner>
    {['f1', 'f2'].map(id => <Button key={id} asChild><Link href={`/products/ebay-flat-file/presentation-test?scope=EBAY&market=IT&account=a&tab=presentation&product=${id}`}>Select family {id}</Link></Button>)}
    <Field label="Fixture account"><Listbox ariaLabel="Fixture account" value={accountId} options={accounts.map(a => ({ value: a.id, label: a.label }))} onChange={setAccount} /></Field>
    <Field label="Fixture market"><Listbox ariaLabel="Fixture market" value={market ?? 'IT'} options={['IT', 'DE'].map(value => ({ value, label: value }))} onChange={setMarket} /></Field>
    <Button onClick={() => window.history.pushState({}, '', `${window.location.pathname}?scope=EBAY&market=DE&account=a&tab=presentation&product=f2`)}>Test programmatic navigation</Button>
  </div>
}
