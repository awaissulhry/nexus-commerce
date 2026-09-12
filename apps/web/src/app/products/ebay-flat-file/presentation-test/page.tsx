import { notFound } from 'next/navigation'
import { PresentationFixture } from './PresentationFixture'

/** Opt-in local fixture only. Never serves a harness against the working catalog. */
export default function PresentationTestPage() {
  if (process.env.NODE_ENV !== 'development' || process.env.NEXT_DEV_STUB_PROXY !== 'http://127.0.0.1:4103') notFound()
  return <PresentationFixture />
}
