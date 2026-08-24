import { ImageUpload } from '@nexus/design-system'

// A deterministic inline SVG so the filled preview renders with no network fetch (SSR and
// client agree; no flaky asset dependency). NOTE: the '#' must be literal here — pre-escaping
// it as '%23' double-encodes through encodeURIComponent and the fill silently falls back to black.
const SAMPLE_IMG =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    "<svg xmlns='http://www.w3.org/2000/svg' width='400' height='400'>" +
      "<rect width='400' height='400' fill='#ffffff'/>" +
      "<rect x='60' y='60' width='280' height='280' rx='56' fill='#1f6fde'/>" +
      "<rect x='120' y='150' width='160' height='28' rx='14' fill='#ffffff'/>" +
      "<rect x='120' y='222' width='104' height='28' rx='14' fill='#ffffff'/>" +
      '</svg>',
  )

// The caller owns the transport; this one resolves immediately to the sample.
const demoUpload = (_file: File): Promise<string> => Promise.resolve(SAMPLE_IMG)

const LOGO_CRITERIA = [
  { label: 'Image Size', value: '400 x 400px or larger' },
  { label: 'File Size', value: '1MB or smaller' },
  { label: 'File Format', value: 'PNG or JPG' },
  { label: 'Content', value: 'Logo fills image on a white/transparent background' },
]

const CUSTOM_CRITERIA = [
  { label: 'Image Size', value: '1200 x 628px or larger' },
  { label: 'File Size', value: '5MB or smaller' },
  { label: 'File Format', value: 'PNG or JPG' },
  { label: 'Content', value: 'No text, graphics, or logos added' },
]

/** Empty state — the square zone plus the `criteria` panel. The Sponsored Brands logo field. */
export const LogoUpload = () => (
  <div style={{ width: 560, maxWidth: '100%' }}>
    <ImageUpload
      label="Logo"
      value=""
      onChange={() => {}}
      onUpload={demoUpload}
      accept="image/png,image/jpeg"
      maxBytes={1024 * 1024}
      minWidth={400}
      minHeight={400}
      aspect="1 / 1"
      criteria={LOGO_CRITERIA}
    />
  </div>
)

/** `aspect` reshapes the zone — `1200 / 628` for the Sponsored Brands custom creative. */
export const WideCreative = () => (
  <div style={{ width: 560, maxWidth: '100%' }}>
    <ImageUpload
      label="Custom Image"
      value=""
      onChange={() => {}}
      onUpload={demoUpload}
      accept="image/png,image/jpeg"
      maxBytes={5 * 1024 * 1024}
      minWidth={1200}
      minHeight={628}
      aspect="1200 / 628"
      criteria={CUSTOM_CRITERIA}
    />
  </div>
)

/** Filled — `value` swaps the zone for the preview and its remove (×) control. */
export const Filled = () => (
  <div style={{ width: 560, maxWidth: '100%' }}>
    <ImageUpload
      label="Logo"
      value={SAMPLE_IMG}
      onChange={() => {}}
      onUpload={demoUpload}
      aspect="1 / 1"
      criteria={LOGO_CRITERIA}
    />
  </div>
)

/** `onSelectFromAssets` adds the DAM browse link under the zone; bare, with no criteria panel. */
export const WithAssetBrowse = () => (
  <div style={{ width: 220, maxWidth: '100%' }}>
    <ImageUpload
      label="Main image"
      value=""
      onChange={() => {}}
      onUpload={demoUpload}
      onSelectFromAssets={() => {}}
      aspect="1 / 1"
    />
  </div>
)

/** `disabled` dims the zone and refuses the click, the drop and the remove control. */
export const Disabled = () => (
  <div style={{ width: 220, maxWidth: '100%' }}>
    <ImageUpload label="Logo" value="" onChange={() => {}} onUpload={demoUpload} disabled aspect="1 / 1" />
  </div>
)
