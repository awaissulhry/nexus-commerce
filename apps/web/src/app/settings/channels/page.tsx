import { Suspense } from 'react'
import { ChannelsClient } from './ChannelsClient'

// `useSearchParams` (the ?tab= sync) needs a Suspense boundary for static rendering.
export default function ChannelsPage() {
  return (
    <Suspense fallback={null}>
      <ChannelsClient />
    </Suspense>
  )
}
