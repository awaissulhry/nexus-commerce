'use client'

/**
 * PA — Portfolio Association for Step 3. Picks an existing Amazon Ads portfolio (fetched
 * from GET /advertising/portfolios — live + locally-created) or creates a new one (POST,
 * gated-local). The chosen portfolioId is persisted onto every launched campaign.
 * Uses the styled H10Select (consistent with the rest of the ads UI) + the DS Modal.
 *
 * CC-5 — the launch market is REQUIRED and the list is that market's portfolios only (`assignablePortfolios`, the
 * grid's and detail page's rule from #358). It defaulted to Italy and three of four builders passed no market, so a
 * German launch listed — and created — Italian portfolios. A portfolio created while Amazon writes are closed gets a
 * Nexus-only id (`local-pf-…`) that Amazon refuses with the whole campaign: it is not offered, and creating one says so
 * instead of selecting it.
 */
import { useEffect, useState } from 'react'
import { Plus } from 'lucide-react'

import { Listbox, Modal } from '@/design-system/components'
import { Button, Input } from '@/design-system/primitives'
import { getBackendUrl } from '@/lib/backend-url'
import { assignablePortfolios, isLocalOnlyPortfolio, type PortfolioOption } from '../../_shared/portfolioPicker'

export function PortfolioPicker({ value, onChange, market, id }: { value: string; onChange: (id: string) => void; market: string; id?: string }) {
  const [pfs, setPfs] = useState<PortfolioOption[]>([])
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  useEffect(() => {
    let alive = true
    setPfs([]); setNote('')
    if (!market) return () => { alive = false }
    fetch(`${getBackendUrl()}/api/advertising/portfolios?marketplace=${encodeURIComponent(market)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (alive && Array.isArray(j?.portfolios)) setPfs(assignablePortfolios(j.portfolios as PortfolioOption[], market)) })
      .catch(() => {})
    return () => { alive = false }
  }, [market])
  // A choice made for another market (or a Nexus-only id) is not kept: it would make Amazon refuse the campaign.
  useEffect(() => {
    if (value && (isLocalOnlyPortfolio(value) || (pfs.length > 0 && !pfs.some((p) => p.portfolioId === value)))) onChange('')
  }, [value, pfs, onChange])
  const options = [{ value: '', label: 'No portfolio' }, ...pfs.map((p) => ({ value: p.portfolioId, label: p.name }))]
  const create = async () => {
    const nm = name.trim()
    if (!nm || busy || !market) return
    setBusy(true)
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/portfolios`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: nm, marketplace: market }) })
      const j = await r.json().catch(() => ({}))
      if (r.ok && j?.portfolio?.portfolioId) {
        setCreating(false); setName('')
        if (isLocalOnlyPortfolio(j.portfolio.portfolioId)) {
          setNote(`"${j.portfolio.name}" was saved in Nexus only: Amazon writes are closed for ${market}, so Amazon does not know it yet and campaigns cannot join it.`)
          return
        }
        setPfs((p) => (p.some((x) => x.portfolioId === j.portfolio.portfolioId) ? p : [...p, { portfolioId: j.portfolio.portfolioId, name: j.portfolio.name, marketplace: market }]))
        onChange(j.portfolio.portfolioId)
      } else {
        setNote(j?.error ? `The portfolio was not created: ${j.error}` : 'The portfolio was not created.')
      }
    } finally { setBusy(false) }
  }
  return (
    <div className="h10-spw-pf">
      <Listbox id={id} width={300} options={options} value={value} onChange={onChange} ariaLabel="Portfolio" disabled={!market} />
      <Button variant="link" size="sm" onClick={() => setCreating(true)} disabled={!market}><Plus size={13} /> Create portfolio</Button>
      {note && <p className="h10-spw-bulk-note" role="status">{note}</p>}
      {creating && (
        <Modal open onClose={() => setCreating(false)} size="sm" title="Create portfolio"
          footer={<><Button onClick={() => setCreating(false)}>Cancel</Button><Button variant="primary" disabled={!name.trim() || busy} onClick={create}>{busy ? 'Creating…' : 'Create'}</Button></>}>
          <p className="h10-spw-bulk-note">A budget-grouping container in {market} — the launched campaigns will join it.</p>
          <label className="h10-spw-bulk-field"><span className="l">Portfolio name</span><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Spring Launch" autoFocus aria-label="Portfolio name" fieldClassName="h10-spw-bulk-txtfield" /></label>
        </Modal>
      )}
    </div>
  )
}
