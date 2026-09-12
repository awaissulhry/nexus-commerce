import { inspectMediaDraft, galleryLabel, type EbayMediaDraft, type EbayMediaWorkspace } from '@nexus/shared/ebay-media'
import { Banner, Disclosure } from '@/design-system/components'
import styles from './media.module.css'

export function MediaReview({ workspace, draft, dirty, accountLabel }: { accountLabel: string; workspace: EbayMediaWorkspace; draft: EbayMediaDraft; dirty: boolean }) {
  const check = inspectMediaDraft(draft, workspace.assets, workspace.axisLabels)
  const inactive = draft.galleries.filter(g => g.axis !== null && g.axis !== draft.axis && g.assetIds.length)
  const axis = workspace.axes.find(a => a.name === draft.axis)
  const unverified = draft.galleries.filter(g => g.axis !== null && g.assetIds.length && !workspace.axes.some(a => a.name === g.axis && a.values.includes(g.value ?? '')))
  const missing = axis?.values.filter(value => !draft.galleries.some(g => g.axis === draft.axis && g.value === value && g.assetIds.length)) ?? []
  return <div className={styles.review}>
    <header><h2>Review your gallery</h2><p>Checks below describe the gallery in this editor. They do not confirm eBay acceptance or what buyers see.</p></header>
    <div className={styles.reviewColumns}>
      <section className={styles.reviewCard}><h3>Saved in Nexus</h3><p>{dirty ? 'There are unsaved gallery changes.' : workspace.destination.inherited ? 'Starting images are loaded. No listing-specific gallery draft has been saved yet.' : 'This editor matches the saved listing draft loaded from Nexus.'}</p>
        <p>{workspace.destination.label} · eBay {workspace.destination.marketplace} · {accountLabel}. Source uploads are shared by the product and saved separately.</p></section>
      <section className={styles.reviewCard}><h3>Live on eBay</h3><p>Not verified in this workspace.</p><p>{workspace.publication.reason}</p></section>
    </div>
    {check.problems.length > 0 && <Banner tone="danger" title="Resolve before saving"><ul>{check.problems.map(problem => <li key={problem}>{problem}</li>)}</ul></Banner>}
    <section className={styles.reviewCard}><h3>Image checks</h3>
      {check.review.length ? <ul>{check.review.map(note => <li key={note}>{note}</li>)}</ul> : <p>Stored dimensions meet the 500-pixel minimum for the selected images. Image content and live URLs still need review.</p>}
      <p>Resolution uses stored original dimensions. A thumbnail loading successfully does not prove that eBay can retrieve or accept the original.</p>
    </section>
    {missing.length > 0 && <section className={styles.reviewCard}><h3>Variation galleries without assigned images</h3><p>{missing.join(', ')}</p><p>The draft preview falls back to the common cover. Live eBay images remain unverified.</p></section>}
    {unverified.length > 0 && <section className={styles.reviewCard}><h3>Saved groups not verified for this destination</h3><p>{unverified.map(g => galleryLabel(g, workspace.axisLabels)).join(' · ')}</p><p>These images are retained. The current variation data does not confirm these groups for the selected destination.</p></section>}
    {inactive.length > 0 && <section className={styles.reviewCard}><h3>Other saved groups are retained</h3><p>{inactive.map(g => galleryLabel(g, workspace.axisLabels)).join(' · ')}</p><p>Changing the grouping does not delete these images or change the grouping of a live listing.</p></section>}
    {workspace.otherImageCount > 0 && <section className={styles.reviewCard}><h3>Other image assignments</h3><p>{workspace.otherImageCount} saved eBay image assignments have a different market, variation or media scope. They are retained when you save this listing draft.</p></section>}
    <Disclosure summary="eBay image guidance and limits">
      <p>Common photos support up to 24 images; each variation photo set supports up to 12. These are eBay’s general limits; category exceptions apply. This editor never silently trims a gallery.</p>
      <p>eBay requires at least 500 pixels on the longest side. Review that photos accurately represent the item and have no added borders, text or watermarks. These content checks require your review.</p>
      <p><a href="https://developer.ebay.com/api-docs/sell/static/inventory/managing-image-media.html" target="_blank" rel="noreferrer">eBay image requirements</a> · <a href="https://www.ebay.com/help/listing-policies/policies/picture-policy?id=4370" target="_blank" rel="noreferrer">eBay picture policy</a></p>
    </Disclosure>
  </div>
}
