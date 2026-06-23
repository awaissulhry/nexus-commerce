'use client'

/**
 * Sponsored Brand creative settings (Helium 10 "Guided" match) — the full SB configuration:
 * Brand · Ad Type (Product Collection / Store Spotlight / Brand Video) · Landing Page · ASINs to
 * advertise · Creative (Display Brand Name, Headline, Logo, Custom Image). Built from DS primitives
 * (Select / Input / MultiSelect) + the DS `ImageUpload` (logo + custom image, uploaded to the DAM
 * via /api/assets/upload). The resulting `SbCreative` is stored on the SB campaigns'
 * `creativeAssetJson` at launch (gated; Amazon push deferred until the write gate opens).
 *
 * Lives in _shared so any builder spanning Sponsored Brand can reuse it.
 */
import { Input, Select } from '@/design-system/primitives'
import { ImageUpload, MultiSelect } from '@/design-system/components'
import { getBackendUrl } from '@/lib/backend-url'
import { InfoTip } from '../campaigns/InfoTip'
import './SponsoredBrandSettings.css'

export type SbAdType = 'productCollection' | 'storeSpotlight' | 'brandVideo'
export interface SbCreative {
  brand: string
  adType: SbAdType
  landingPageType: string
  landingPageUrl: string
  asins: string[]
  displayBrandName: string
  headline: string
  logoUrl: string | null
  customImageUrl: string | null
}
export const defaultSbCreative = (brand = ''): SbCreative => ({
  brand, adType: 'productCollection', landingPageType: 'Brand Store', landingPageUrl: 'Home page',
  asins: [], displayBrandName: brand, headline: '', logoUrl: null, customImageUrl: null,
})

const AD_TYPES: Array<{ key: SbAdType; label: string; desc: string }> = [
  { key: 'productCollection', label: 'Product Collection', desc: 'Promote products from a store or landing page' },
  { key: 'storeSpotlight', label: 'Store Spotlight', desc: 'Drive traffic to a store' },
  { key: 'brandVideo', label: 'Brand Video', desc: 'Use a video to drive traffic to a store, landing page, or product page' },
]

/** Upload a file to the DAM and return its URL (the ImageUpload transport). */
async function uploadAsset(file: File): Promise<string> {
  const fd = new FormData()
  fd.append('file', file, file.name)
  const res = await fetch(`${getBackendUrl()}/api/assets/upload`, { method: 'POST', body: fd })
  const body = (await res.json().catch(() => ({}))) as { asset?: { url?: string }; error?: string }
  if (!res.ok || !body?.asset?.url) throw new Error(body?.error || `Upload failed (${res.status})`)
  return body.asset.url
}

export function SponsoredBrandSettings({ value, onChange, products, brands }: {
  value: SbCreative
  onChange: (patch: Partial<SbCreative>) => void
  products: Array<{ id: string; name: string; asin: string; sku: string }>
  brands: string[]
}) {
  const asinOptions = products.map((p) => ({ value: p.asin || p.sku || p.id, label: `${p.name}${p.asin ? ` · ${p.asin}` : ''}` }))
  return (
    <div className="h10-sbs">
      <div className="h10-spw-field">
        <span className="lbl">Brand <i className="req">*</i></span>
        <Select value={value.brand} onChange={(e) => onChange({ brand: e.target.value })} aria-label="Brand">
          {!value.brand && <option value="">Select a brand</option>}
          {brands.map((b) => <option key={b} value={b}>{b}</option>)}
        </Select>
      </div>

      <div className="h10-sbs-sec">
        <h3>Sponsored Brand Ad Type</h3>
        <div className="h10-sbs-radios">
          {AD_TYPES.map((o) => (
            <label key={o.key} className={`h10-sbs-radio ${value.adType === o.key ? 'on' : ''}`}>
              <input type="radio" name="sbs-adtype" checked={value.adType === o.key} onChange={() => onChange({ adType: o.key })} />
              <span className="rb"><b>{o.label}</b><span className="d">{o.desc}</span></span>
            </label>
          ))}
        </div>
      </div>

      <div className="h10-sbs-sec">
        <h3>Landing Page</h3>
        <div className="h10-sbs-grid2">
          <label className="h10-spw-field"><span className="lbl">Landing Page Type</span>
            <Select value={value.landingPageType} onChange={(e) => onChange({ landingPageType: e.target.value })} aria-label="Landing page type">
              <option>Brand Store</option><option>New landing page</option><option>Product list page</option>
            </Select>
          </label>
          <label className="h10-spw-field"><span className="lbl">Landing Page URL</span>
            <Select value={value.landingPageUrl} onChange={(e) => onChange({ landingPageUrl: e.target.value })} aria-label="Landing page URL">
              <option>Home page</option><option>All products</option><option>Best sellers</option>
            </Select>
          </label>
        </div>
      </div>

      <div className="h10-sbs-sec">
        <h3>Select ASINs to Advertise from the Product Group</h3>
        <MultiSelect options={asinOptions} value={value.asins} onChange={(asins) => onChange({ asins })} placeholder="Select ASINs to advertise" />
      </div>

      <div className="h10-sbs-sec">
        <h3>Creative</h3>
        <div className="h10-sbs-creative">
          <label className="h10-spw-field"><span className="lbl">Display Brand Name <i className="req">*</i></span>
            <Input value={value.displayBrandName} onChange={(e) => onChange({ displayBrandName: e.target.value })} aria-label="Display brand name" />
          </label>
          <label className="h10-spw-field"><span className="lbl">Headline <i className="req">*</i> <InfoTip tip="The headline shown beside your logo in the ad (50 characters max)." /></span>
            <Input value={value.headline} maxLength={50} onChange={(e) => onChange({ headline: e.target.value })} placeholder="Enter Headline title (50 characters max)" aria-label="Headline" />
          </label>
          <ImageUpload
            label="Logo" value={value.logoUrl} onChange={(url) => onChange({ logoUrl: url })} onUpload={uploadAsset}
            accept="image/png,image/jpeg" maxBytes={1024 * 1024} minWidth={400} minHeight={400} aspect="1 / 1"
            criteria={[
              { label: 'Image Size', value: '400 x 400px or larger' },
              { label: 'File Size', value: '1MB or smaller' },
              { label: 'File Format', value: 'PNG or JPG' },
              { label: 'Content', value: 'Logo fills image on a white/transparent background' },
            ]}
          />
          <ImageUpload
            label="Custom Image" value={value.customImageUrl} onChange={(url) => onChange({ customImageUrl: url })} onUpload={uploadAsset}
            accept="image/png,image/jpeg" maxBytes={5 * 1024 * 1024} minWidth={1200} minHeight={628} aspect="1200 / 628"
            criteria={[
              { label: 'Image Size', value: '1200 x 628px or larger' },
              { label: 'File Size', value: '5MB or smaller' },
              { label: 'File Format', value: 'PNG or JPG' },
              { label: 'Content', value: 'No text, graphics, or logos added' },
            ]}
          />
        </div>
      </div>
    </div>
  )
}
