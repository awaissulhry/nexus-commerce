'use client'

import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import Link from '@/lib/workspaces/Link'
import { Banner, Drawer, Field, Listbox, OrderedList, ProgressBar } from '@/design-system/components'
import { DataGrid } from '@/design-system/grid/datagrid'
import { Button, Input, Textarea } from '@/design-system/primitives'
import { PageHeader } from '@/design-system/patterns'
import { getBackendUrl } from '@/lib/backend-url'
import { ImpactReview } from '../../mapping/_shared/ImpactReview'
import * as api from '../../mapping/_shared/api'

const initialRule = (): api.PresentationRule => ({ id: crypto.randomUUID(), name: '', version: 0, priority: 10, scope: {} })

export default function PresentationRulesPage() {
  const search = useSearchParams()
  const [market, setMarket] = useState(search.get('market') ?? 'IT')
  const [markets, setMarkets] = useState<string[]>([])
  const [data, setData] = useState<Awaited<ReturnType<typeof api.fetchPresentationRules>> | null>(null)
  const [themes, setThemes] = useState<Array<{ id: string; name: string; version: number; active: boolean }>>([])
  const [draft, setDraft] = useState<api.PresentationRule | null>(null)
  const [axis, setAxis] = useState('Size')
  const [values, setValues] = useState('XS\nS\nM\nL\nXL')
  const [review, setReview] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [refresh, setRefresh] = useState(0)
  const [discard, setDiscard] = useState(false)
  const openedRule = useRef<string | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    setData(null); setError(null)
    void api.fetchPresentationRules(market, controller.signal).then(result => { if (!controller.signal.aborted) setData(result) }).catch(e => { if (!controller.signal.aborted) setError(e.message) })
    return () => controller.abort()
  }, [market, refresh])
  useEffect(() => {
    const id = search.get('rule')
    if (!id || !data || openedRule.current === `${market}:${id}`) return
    const rule = data.rules.find(r => r.id === id)
    if (rule) { openedRule.current = `${market}:${id}`; setDraft(structuredClone(rule)) }
  }, [data, market, search])
  useEffect(() => {
    const controller = new AbortController()
    void api.fetchTemplates().then(rows => { if (!controller.signal.aborted) setMarkets(rows.filter(r => r.channel === 'EBAY').map(r => r.code)) }).catch(e => { if (!controller.signal.aborted) setError(e.message) })
    void fetch(`${getBackendUrl()}/api/ebay/description-themes`, { credentials: 'include', signal: controller.signal }).then(async r => {
      if (!r.ok) throw new Error('Description themes could not load')
      const result = await r.json(); if (!controller.signal.aborted) setThemes(result.themes)
    }).catch(e => { if (!controller.signal.aborted) setError(e.message) })
    return () => controller.abort()
  }, [])
  useEffect(() => {
    if (!draft) return
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [draft])
  const close = () => {
    if (busy) return
    if (discard) { setDiscard(false); return }
    if (draft) { setDiscard(true); return }
    setReview(null)
  }
  const preview = async (id: string, rule: api.PresentationRule | null) => {
    if (!data) return
    setBusy(true); setError(null)
    try { const result = await api.reviewPresentationRule(market, data.token, id, rule); setReview(result.jobId); setDraft(null) }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }
  return <>
    <PageHeader title="Presentation defaults & variation order rules" subtitle="Reusable eBay rules, with separate product and listing customizations" actions={
      <Button disabled={!data} onClick={() => { setReview(null); setDraft(initialRule()) }}>New rule</Button>
    } />
    <div style={{ display: 'grid', gap: 'var(--nds-space-16)', padding: 'var(--nds-space-16)', minWidth: 0 }}>
      <Field label="Market"><Listbox value={market} onChange={setMarket} ariaLabel="Presentation rule market" options={markets.map(m => ({ value: m, label: m }))} /></Field>
      <Banner tone="info">Rules apply to matching primary and alternate listings in this market. Highest priority wins for each presentation property. Conflicting equal-priority rules require resolution. Explicit listing values stay in place. Shared categories match direct membership, including membership inherited from a variant’s parent.</Banner>
      <Button asChild variant="link"><Link href={`/channels/ebay/description-themes?market=${encodeURIComponent(market)}`}>Open description themes, versions and editor</Link></Button>
      {error && <Banner tone="danger">{error}</Banner>}
      {!data && !error ? <ProgressBar indeterminate ariaLabel="Loading presentation rules" /> : <DataGrid ariaLabel="Presentation rules" rows={data?.rules ?? []} rowKey={r => r.id} columns={[
        { key: 'name', label: 'Rule / version', render: r => `${r.name} · v${r.version}` },
        { key: 'scope', label: 'Matching criteria', render: r => Object.entries(r.scope).map(([k, v]) => `${k}: ${v}`).join(' · ') || 'All products and accounts in this market' },
        { key: 'priority', label: 'Priority', render: r => r.priority },
        { key: 'result', label: 'Presentation', render: r => [r.themeId && (themes.find(t => t.id === r.themeId)?.name ?? r.themeId), r.order && 'Buyer-facing variation order'].filter(Boolean).join(' · ') },
        { key: 'actions', label: 'Actions', render: r => <><Button size="sm" onClick={() => { setReview(null); setDraft(structuredClone(r)) }}>Edit / review usage</Button><Button size="sm" onClick={() => void preview(r.id, null)}>Review removal</Button></> },
      ]} />}
    </div>
    <Drawer open={!!draft || !!review} onClose={close} width={760} title={discard ? 'Discard presentation-rule draft?' : review ? 'Review affected listings' : 'Presentation rule'} footer={!discard && draft && <Button variant="primary" disabled={busy || !draft.name.trim()} onClick={() => void preview(draft.id, draft)}>{busy ? 'Preparing review…' : 'Review affected listings'}</Button>}>
      <div style={{ display: 'grid', gap: 'var(--nds-space-12)', padding: 'var(--nds-space-16)', minWidth: 0 }}>
        {discard ? <>
          <Banner tone="warning">Your draft has not been saved or activated.</Banner>
          <Button autoFocus onClick={() => setDiscard(false)}>Keep editing</Button>
          <Button variant="danger" onClick={() => { setDiscard(false); setDraft(null); setReview(null) }}>Discard draft</Button>
        </> : <>
        {error && <Banner tone="danger">{error}</Banner>}
        {review ? <ImpactReview key={review} jobId={review} onApplied={() => setRefresh(n => n + 1)} /> : draft && <>
          <Field label="Rule name"><Input value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} /></Field>
          <Field label="Priority" hint="0–100; highest matching priority wins separately for theme and order."><Input type="number" min={0} max={100} value={draft.priority} onChange={e => setDraft({ ...draft, priority: Number(e.target.value) })} /></Field>
          {([['accountId', 'Account ID'], ['familyId', 'Shared product family ID'], ['sharedCategoryId', 'Shared category ID'], ['marketplaceCategoryId', 'eBay category ID']] as const).map(([key, label]) => <Field key={key} label={label} hint="Optional; leave empty to include all. This selector is checked by the resolver."><Input value={draft.scope[key] ?? ''} onChange={e => {
            const scope = { ...draft.scope }; if (e.target.value.trim()) scope[key] = e.target.value.trim(); else delete scope[key]; setDraft({ ...draft, scope })
          }} /></Field>)}
          <Field label="Description theme"><Listbox ariaLabel="Rule description theme" value={draft.themeId ?? ''} onChange={themeId => setDraft({ ...draft, themeId: themeId || undefined })} options={[
            { value: '', label: 'Leave the theme unchanged' }, { value: 'none', label: 'Description body only' }, ...themes.filter(t => t.active).map(t => ({ value: t.id, label: `${t.name} · v${t.version}` })),
          ]} /></Field>
          <Banner tone="neutral">Variation rules reorder existing axes and values. They do not create variants, choose variation dimensions, or change grid sorting.</Banner>
          <Field label="Variation axis"><Input value={axis} onChange={e => setAxis(e.target.value)} /></Field>
          <Field label="Preferred buyer-facing values" hint="One value per line. Other eligible values follow using the existing deterministic order."><Textarea rows={5} value={values} onChange={e => setValues(e.target.value)} /></Field>
          <Button onClick={() => { if (!axis.trim()) return; const ordered = [...new Set(values.split('\n').map(v => v.trim()).filter(Boolean))]; setDraft({ ...draft, order: { axes: [...new Set([...(draft.order?.axes ?? []), axis.trim()])], values: { ...draft.order?.values, [axis.trim()]: ordered } } }) }}>Add axis order to draft</Button>
          {draft.order && <><OrderedList label="Buyer-facing axis order" items={draft.order.axes} onChange={axes => setDraft({ ...draft, order: { ...draft.order!, axes } })} />
            {Object.entries(draft.order.values).map(([name, items]) => <OrderedList key={name} label={`${name} value order`} items={items} onChange={next => setDraft({ ...draft, order: { ...draft.order!, values: { ...draft.order!.values, [name]: next } } })} />)}
            <Button onClick={() => setDraft({ ...draft, order: undefined })}>Remove variation order from draft</Button>
            {!data?.orderActivationAvailable && <Banner tone="warning">Variation-order reviews are available. Saving an order rule is unavailable until all listing workflows support it.</Banner>}
          </>}
        </>}
        </>}
      </div>
    </Drawer>
  </>
}
