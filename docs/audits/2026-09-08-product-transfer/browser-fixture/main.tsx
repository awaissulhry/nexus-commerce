import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ProductTransferDrawer } from '@/app/products/[id]/edit/_studio/import/ProductTransferDrawer'
import { Button } from '@/design-system/primitives'
import { Drawer } from '@/design-system/components'
import { SourceMappingEditor } from '@/app/products/catalog-transfer/SourceMappingEditor'
import { TransferReview } from '@/app/products/catalog-transfer/TransferReview'
import { defaultSourceMapping } from '@/app/products/catalog-transfer/sourceMapping'
import '@/design-system/styles/tokens-global.css'
import '@/design-system/styles/primitives.css'
import '@/design-system/styles/components.css'
import '@/design-system/styles/patterns.css'
import '@/design-system/styles/a11y.css'
import './style.css'
function App() {
  const [intent, setIntent] = useState<'import'|'export'>('export'), [open, setOpen] = useState(false), [refreshes, setRefreshes] = useState(0), [dark, setDark] = useState(false)
  const [source,setSource]=useState<any>(null),[options,setOptions]=useState<any>(null),[mapping,setMapping]=useState<any>(null),[jobId,setJobId]=useState(''),[fixtureOpen,setFixtureOpen]=useState(false),[error,setError]=useState('')
  const post=async(path:string,body?:any)=>{ const r=await fetch('/api/'+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)}); const data=await r.json();if(!r.ok)throw new Error(data.error);return data }
  const load=async()=>{try{const o=await post('catalog-transfer/products/p1/options'),s=await post('fixture/source',{});setOptions({...o,families:[],listings:o.listings.filter((l:any)=>l.productId==='p1'&&l.marketplace==='IT')});setSource(s);setMapping(defaultSourceMapping(s.headers,'IT','update'));setFixtureOpen(true)}catch(e:any){setError(e.message)}}
  const preview=async()=>{try{const j=await post('catalog-transfer/products/p1/source/preview',{sourceId:source.sourceId,inputHash:source.hash,mapping,selection:{productIds:['p1'],includeShared:true,locales:[],listingIds:options.listings.map((l:any)=>l.id)}});setJobId(j.jobId)}catch(e:any){setError(e.message)}}
  return <><h1>Product transfer verification</h1><p>Isolated test catalog · actual transfer UI and API · no live products.</p><div style={{display:'flex',flexWrap:'wrap',gap:12}}><Button onClick={() => { setIntent('export'); setOpen(true) }}>Export</Button><Button onClick={() => {setIntent('import'); setOpen(true)}}>Import</Button><Button onClick={load}>Load synthetic supplier for mapping checks</Button><Button onClick={() => {setDark(!dark); document.documentElement.classList.toggle('dark',!dark)}}>{dark ? 'Light mode' : 'Dark mode'}</Button></div><p role="status">Grid refresh requests: {refreshes}</p>{error&&<p role="alert">{error}</p>}<ProductTransferDrawer productId="p1" market="IT" channel="AMAZON" accountId="account-a" aliasKey="" selectedIds={['p1','p2']} visibleFields={['item_name','material']} open={open} intent={intent} onClose={() => setOpen(false)} onApplied={() => setRefreshes(n=>n+1)} onReference={() => {}} /><Drawer open={fixtureOpen} onClose={()=>setFixtureOpen(false)} width={900} title="Isolated supplier mapping and review">{error&&<p role="alert">{error}</p>}{jobId?<TransferReview key={jobId} jobId={jobId} options={options} productId="p1" onJob={setJobId} onReset={()=>setJobId('')} onSettled={()=>setRefreshes(n=>n+1)} onReturn={()=>setFixtureOpen(false)}/>:source&&<><p>Synthetic source supplied by the fixture server. Native file-picker automation is unavailable; HTTP upload is covered by route tests.</p><SourceMappingEditor source={source} mapping={mapping} onChange={setMapping} options={options} productId="p1" familyId="f1" disabled={false}/><Button onClick={preview} disabled={!mapping.bindings.length}>Review synthetic source</Button></>}</Drawer></>
}
createRoot(document.getElementById('root')!).render(<App />)
