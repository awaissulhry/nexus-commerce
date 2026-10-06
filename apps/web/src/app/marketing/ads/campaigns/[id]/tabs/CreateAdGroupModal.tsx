'use client'

/**
 * CBN.3.4 — "Create Ad Group: Settings" modal (H10 match). Name + default bid, POSTed to /advertising/adgroups/create
 * ({ campaignId, name, defaultBidEur }).
 *
 * CM-31 — the targeting is shown, not asked: on Sponsored Products it belongs to the campaign, and the Auto / Keyword /
 * Product choice this modal offered was sent and never read (see adGroupTargeting.ts).
 */
import { useState } from 'react'
import { Button, Input } from '@/design-system/primitives'
import { Field, Modal, useToast } from '@/design-system/components'
import { adsAdd } from '../../../_shared/adsWrite'
import { adGroupTargetingWords } from './adGroupTargeting'
import '../../campaigns-ds.css'

export function CreateAdGroupModal({ campaignId, campaign, currency = '€', onClose, onCreated }: {
  campaignId: string
  /** The campaign the group joins: its targeting type is shown read-only (CM-31). */
  campaign?: { adProduct?: string | null; type?: string | null; targetingType?: string | null } | null
  currency?: string; onClose: () => void; onCreated: () => void
}) {
  const [name, setName] = useState('')
  const [bid, setBid] = useState('0.50')
  const targeting = adGroupTargetingWords(campaign)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const { toast } = useToast()
  const valid = name.trim() !== '' && Number(bid) > 0

  async function create() {
    setBusy(true); setErr(null)
    // CM-8 — created means Amazon holds the ad group; otherwise the write gate's or Amazon's reason is shown.
    const r = await adsAdd('/api/advertising/adgroups/create', { campaignId, name: name.trim(), defaultBidEur: Number(bid) })
    setBusy(false)
    if (r.added || r.savedOnly) {
      if (r.savedOnly) toast(`Ad group saved in Nexus only: ${r.reason}`, 'warning', { duration: 9000 })
      onCreated(); onClose(); return
    }
    // Nothing was written: the reason stays here, and creating again is safe.
    setErr(`Not created: ${r.reason}`)
  }

  return (
    <Modal
      open
      onClose={onClose}
      size="md"
      title="Create Ad Group: Settings"
      subtitle="Set the name and default bid"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <span className="grow" />
          <Button variant="primary" disabled={!valid || busy} onClick={() => void create()}>{busy ? 'Creating…' : 'Create Ad Group'}</Button>
        </>
      }
    >
      <Field className="cd-field" label="Ad Group Name">
        <Input placeholder="Enter ad group name" value={name} onChange={(e) => setName(e.target.value)} autoFocus fieldClassName="cd-field-full" />
      </Field>
      <Field className="cd-field s" label="Default Bid">
        <Input inputMode="decimal" prefix={currency} value={bid} onChange={(e) => setBid(e.target.value)} fieldClassName="cd-money-field" />
      </Field>
      <Field className="cd-field" label="Targeting" hint={targeting.hint}>
        <Input value={targeting.value} readOnly aria-readonly="true" fieldClassName="cd-field-full" />
      </Field>
      {err && <div className="h10-cd-modalerr">{err}</div>}
    </Modal>
  )
}
