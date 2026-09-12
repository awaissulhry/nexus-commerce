import { notFound } from 'next/navigation'
import { ResponsiveMediaFrame } from './frame'

/** A real narrow viewport for the isolated Media API fixture, never a production route. */
export default function Page() {
  if (process.env.NODE_ENV !== 'development' || process.env.NEXT_DEV_STUB_PROXY !== 'http://127.0.0.1:4118') notFound()
  return <ResponsiveMediaFrame />
}
