'use client'

/**
 * PA — Portfolio Association for Step 3. Picks an existing Amazon Ads portfolio (fetched
 * from GET /advertising/portfolios — live + locally-created) or creates a new one (POST,
 * gated-local). The chosen portfolioId is persisted onto every launched campaign.
 * Uses the styled H10Select (consistent with the rest of the ads UI) + the DS Modal.
 */
import { useEffect, useState } from 'react'
import { Plus } from 'lucide-react'
import { H10Select } from '../../campaigns/FilterDropdown'
import { Modal } from '@/design-system/components'
import { Button, Input } from '@/design-system/primitives'
import { getBackendUrl } from '@/lib/backend-url'

type Pf = { portfolioId: string; name: string }

export function PortfolioPicker({ value, onChange, market = 'IT' }: { value: string; onChange: (id: string) => void; market?: string }) {
  const [pfs, setPfs] = useState<Pf[]>([])
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let alive = true
    fetch(`${getBackendUrl()}/api/advertising/portfolios?marketplace=${market}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (alive && Array.isArray(j?.portfolios)) setPfs(j.portfolios.map((p: Pf) => ({ portfolioId: p.portfolioId, name: p.name }))) })
      .catch(() => {})
    return () => { alive = false }
  }, [market])
  const options = [{ value: '', label: 'No portfolio' }, ...pfs.map((p) => ({ value: p.portfolioId, label: p.name }))]
  const create = async () => {
    const nm = name.trim()
    if (!nm || busy) return
    setBusy(true)
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/portfolios`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: nm, marketplace: market }) })
      const j = await r.json().catch(() => ({}))
      if (r.ok && j?.portfolio?.portfolioId) {
        setPfs((p) => (p.some((x) => x.portfolioId === j.portfolio.portfolioId) ? p : [...p, { portfolioId: j.portfolio.portfolioId, name: j.portfolio.name }]))
        onChange(j.portfolio.portfolioId)
        setCreating(false); setName('')
      }
    } finally { setBusy(false) }
  }
  return (
    <div className="h10-spw-pf">
      <H10Select width={300} options={options} value={value} onChange={onChange} ariaLabel="Portfolio" />
      <button type="button" className="h10-spw-pf-new" onClick={() => setCreating(true)}><Plus size={13} /> Create portfolio</button>
      {creating && (
        <Modal open onClose={() => setCreating(false)} size="sm" title="Create portfolio"
          footer={<><Button onClick={() => setCreating(false)}>Cancel</Button><Button variant="primary" disabled={!name.trim() || busy} onClick={create}>{busy ? 'Creating…' : 'Create'}</Button></>}>
          <p className="h10-spw-bulk-note">A budget-grouping container — the launched campaigns will join it.</p>
          <label className="h10-spw-bulk-field"><span className="l">Portfolio name</span><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Spring Launch" autoFocus aria-label="Portfolio name" fieldClassName="h10-spw-bulk-txtfield" /></label>
        </Modal>
      )}
    </div>
  )
}
