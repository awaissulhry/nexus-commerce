'use client'
import { useState } from 'react'
import { ArrowRight } from 'lucide-react'
import { amazonSlotsForSection, effectiveImageSlots, planAmazonBulkImages, type AmazonBulkMode, type AmazonImageSection, type AmazonMediaDraft, type AmazonMediaWorkspace } from '@nexus/shared/amazon-media'
import { Banner, Disclosure, Field, MediaCard, Modal, Thumbnail } from '@/design-system/components'
import { Button, Checkbox, Select, Tag } from '@/design-system/primitives'
import { SkuSelection } from './SkuSelection'
import styles from './media.module.css'

export function BulkImageAssignment({ workspace, draft, active, section, axis, disabled, onClose, onApply }: {
  workspace: AmazonMediaWorkspace; draft: AmazonMediaDraft; active: string; section: AmazonImageSection; axis: string; disabled: boolean
  onClose(): void; onApply(next: AmazonMediaDraft, count: number): void
}) {
  const definitions = amazonSlotsForSection(section)
  const [sourceId, setSourceId] = useState(active)
  const source = sourceId === 'common' ? draft.common : effectiveImageSlots(draft, sourceId)
  const [codes, setCodes] = useState(definitions.filter(s => source[s.code]).map(s => s.code))
  const [ids, setIds] = useState<string[]>([])
  const [mode, setMode] = useState<AmazonBulkMode>('fill')
  const [language, setLanguage] = useState('')
  const [review, setReview] = useState(false)
  const [inspect, setInspect] = useState<string | null>(null)
  const targets = workspace.items.filter(i => i.id !== sourceId || mode === 'inherit' || mode === 'clear')
  const validIds = ids.filter(id => targets.some(i => i.id === id))
  const plan = planAmazonBulkImages(draft, source, validIds, codes, mode, language || undefined)
  const changedIds = [...new Set(plan.changes.map(c => c.listingId))]
  const available = definitions.filter(s => mode === 'clear' || mode === 'inherit' || source[s.code])
  const asset = (id?: string) => workspace.assets.find(a => a.id === id)
  const inspected = asset(inspect ?? undefined)
  const languageLabel = (code: string) => code === 'zxx' ? 'Language-neutral' : code === 'und' ? 'Language needs review' : new Intl.DisplayNames(['en'], { type: 'language' }).of(code) ?? code
  return <><Modal open onClose={onClose} title={review ? 'Review bulk image changes' : 'Apply images to SKUs'}
    subtitle={`${workspace.destination.marketplace} · ${workspace.destination.label} · ${section === 'safety' ? 'Safety images (PS)' : 'Product gallery'}`} size="xl"
    footer={<><Button onClick={onClose}>Cancel</Button>{review ? <>
      <Button onClick={() => setReview(false)}>Back</Button>
      <Button variant="primary" disabled={disabled || !plan.changes.length} onClick={() => onApply(plan.draft, changedIds.length)}>Apply to {changedIds.length} SKUs</Button>
    </> : <Button variant="primary" disabled={disabled || !plan.changes.length} onClick={() => setReview(true)}>Review {plan.changes.length} changes</Button>}</>}>
    {review ? <>
      <p>{plan.changes.length} slot changes across {changedIds.length} SKUs. {validIds.length - changedIds.length} selected SKUs are unchanged. These changes stay in the draft until you save.</p>
      {mode === 'clear' && <Banner tone="warning">Selected slots will be explicitly empty, including where a common image exists.</Banner>}
      {section === 'safety' && <Banner tone="info">PS images are prepared for Seller Central upload. Applying them here does not publish them to Amazon.</Banner>}
      {changedIds.map(id => <Disclosure key={id} summary={`${workspace.items.find(i => i.id === id)?.sku || id} · ${plan.changes.filter(c => c.listingId === id).length} changes`} open={changedIds.length <= 3}>
        <div className={styles.selectionList}>{plan.changes.filter(c => c.listingId === id).map(c => <div key={c.slot} className={styles.change}>
          <strong>{c.slot}</strong><Thumbnail src={asset(c.before?.assetId)?.url ?? null} alt={`Before ${c.slot}`} /><ArrowRight size={16} aria-hidden />
          <Thumbnail src={asset(c.after?.assetId)?.url ?? null} alt={`After ${c.slot}`} />
          <span>{c.inherited ? 'Use common image' : c.after ? c.before?.assetId === c.after.assetId && c.before.language === c.after.language ? 'Keep image as SKU override' : c.before ? 'Replace assignment' : 'Assign image' : 'Clear slot'}{c.after ? ` · ${languageLabel(c.after.language)}` : ''}</span>
        </div>)}</div>
      </Disclosure>)}
    </> : <div className={styles.bulkColumns}>
      <div className={styles.selectionList}>
        <Field label="Change"><Select value={mode} onChange={e => setMode(e.target.value as AmazonBulkMode)}>
          <option value="fill">Fill unassigned slots</option><option value="replace">Replace selected slots</option><option value="inherit">Use common images</option><option value="clear">Clear selected slots</option>
        </Select></Field>
        <p className={styles.note}>{mode === 'fill' ? 'Keeps existing images and explicit clears. Assigns only where no image or clear has been set.' : mode === 'replace' ? 'Copies only the selected images. Every unselected slot is retained.' : mode === 'inherit' ? 'Removes selected SKU overrides so they follow this market’s common images, including future edits.' : 'Clears only selected slots and stops them inheriting common images.'}</p>
        {(mode === 'fill' || mode === 'replace') && <>
          <Field label="Source gallery"><Select value={sourceId} onChange={e => {
            const id = e.target.value; setSourceId(id)
            const slots = id === 'common' ? draft.common : effectiveImageSlots(draft, id)
            setCodes(definitions.filter(s => slots[s.code]).map(s => s.code)); setIds(current => current.filter(i => i !== id))
          }}><option value="common">Common images</option>{workspace.items.map(i => <option key={i.id} value={i.id}>{i.sku || i.label}</option>)}</Select></Field>
          <Field label="Image language" hint="Choose a language only after checking the text in every selected image."><Select value={language} onChange={e => setLanguage(e.target.value)}>
            <option value="">Keep each image’s language</option><option value="und">Require language review</option><option value="zxx">Confirm no language-specific text</option>
            {workspace.languages.map(code => <option key={code} value={code}>Confirm {new Intl.DisplayNames(['en'], { type: 'language' }).of(code)} content</option>)}
          </Select></Field>
        </>}
        <div className={styles.actions}><strong>Image slots</strong><Tag>{codes.filter(c => available.some(s => s.code === c)).length} selected</Tag>
          <Button size="sm" onClick={() => setCodes(available.map(s => s.code))}>Select all slots</Button><Button size="sm" onClick={() => setCodes([])}>Clear slot selection</Button></div>
        <div className={styles.bulkPhotos}>{available.map(slot => {
          const a = asset((mode === 'inherit' ? draft.common : source)[slot.code]?.assetId)
          const toggle = (checked: boolean) => setCodes(current => checked ? [...new Set([...current, slot.code])] : current.filter(c => c !== slot.code))
          return a ? <MediaCard key={slot.code} src={a.url} label={slot.label} marker={slot.code} selected={codes.includes(slot.code)} onSelectedChange={toggle} onPreview={() => setInspect(a.id)} />
            : <Checkbox key={slot.code} label={`${slot.code} · ${slot.label}`} checked={codes.includes(slot.code)} onChange={e => toggle(e.target.checked)} />
        })}</div>
        {!available.length && <p>This source has no assigned images in this section. Choose images in its gallery first.</p>}
      </div>
      <div className={styles.selectionList}><strong>Target SKUs</strong><SkuSelection items={targets} selected={validIds} onChange={setIds} defaultAxis={axis} disabled={disabled} />
        <p role="status" className={styles.note}>{plan.changes.length} slot changes across {changedIds.length} SKUs.</p>
        {validIds.length > 0 && !plan.changes.length && <p className={styles.note}>{mode === 'fill' ? 'Existing images, common images and explicit clears are already retained. Choose Replace selected slots to change them.' : 'The selected slots already match this change, or no image slots are selected.'}</p>}</div>
    </div>}
  </Modal><Modal open={!!inspected} onClose={() => setInspect(null)} title={inspected?.label ?? 'Inspect image'} size="xl">{inspected && <img className={styles.inspection} src={inspected.url} alt={inspected.label} />}</Modal></>
}
