import { Banner, Button } from '@nexus/design-system'

const Stack = ({ children }: { children: React.ReactNode }) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>{children}</div>
)

/** The tone sweep — each tone brings its own lucide icon and colour. */
export const Tones = () => (
  <Stack>
    <Banner variant="info" title="Sandbox mode">
      Changes here won&apos;t push to live marketplaces until you publish.
    </Banner>
    <Banner variant="success" title="All channels in sync">
      Amazon, eBay and Shopify reflect the latest catalogue.
    </Banner>
    <Banner variant="warning" title="2 listings missing images">
      Add a main image before these can go live.
    </Banner>
    <Banner variant="error" title="Publish failed — rate limited">
      Amazon throttled the feed. We&apos;ll back off and retry automatically.
    </Banner>
  </Stack>
)

/** `action` takes the trailing slot; `onDismiss` adds the × control. */
export const WithActionAndDismiss = () => (
  <Stack>
    <Banner
      variant="info"
      title="Sandbox mode"
      action={<Button size="sm">Learn more</Button>}
      onDismiss={() => {}}
    >
      Changes here won&apos;t push to live marketplaces until you publish.
    </Banner>
    <Banner variant="error" title="Publish failed — rate limited" action={<Button size="sm">Retry</Button>}>
      Amazon throttled the feed. We&apos;ll back off and retry automatically.
    </Banner>
  </Stack>
)

/** Title-only, no body — the compact form for a one-line status. */
export const TitleOnly = () => (
  <Stack>
    <Banner variant="success" title="Bid changes applied to 41 targets." />
    <Banner variant="warning" title="Budget cap reached on 3 campaigns." onDismiss={() => {}} />
  </Stack>
)
