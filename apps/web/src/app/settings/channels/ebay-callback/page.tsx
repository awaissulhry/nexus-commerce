import { Suspense } from 'react'
import { Spinner } from '@/design-system/primitives'
import EbayCallbackContent from './EbayCallbackContent'

// CX.1 made this page a forwarder to the API-host callback; CX.2 puts the one
// thing it renders on the design system.
function Forwarding() {
  return (
    <div style={{ minHeight: '40vh', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 'var(--nds-space-2)', color: 'var(--nds-text-muted)' }}>
      <Spinner size={16} />
      <span>Finishing eBay sign-in…</span>
    </div>
  )
}

export default function EbayCallbackPage() {
  return (
    <Suspense fallback={<Forwarding />}>
      <EbayCallbackContent />
    </Suspense>
  )
}
