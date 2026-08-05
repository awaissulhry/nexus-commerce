/**
 * ACR.2.2 — Coverage replaces the analytics stub.
 *
 * The stub read "This screen is being rebuilt to match Adtomic". It is not a pixel-match of
 * anything now: per the standing split (Reporting = data, Analytics = meaning) this page answers
 * one question — how much of page one do we hold, per keyword — and does not try to be a general
 * analytics surface.
 */
import { CoverageClient } from './CoverageClient'

export const dynamic = 'force-dynamic'

export default function Page() {
  return <CoverageClient />
}
