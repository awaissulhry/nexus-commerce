/** Trading Desk — Launch (P4), native in the hub. */
import type { Metadata } from 'next'
import { LaunchFlow } from './LaunchFlow'

export const metadata: Metadata = { title: 'Launch · Trading Desk' }
export const dynamic = 'force-dynamic'

export default function TradingDeskLaunchPage() {
  return <LaunchFlow />
}
