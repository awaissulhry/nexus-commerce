/** AI Advertising — landing/launcher for the AI Goal (Product Goal) builder.
 *  Full dashboard (Get Started + product-goal table) is a follow-up; this hosts the
 *  primary "New Product Goal" entry so the sidebar item leads into the AI Goal flow. */
import Link from 'next/link'
import { Plus } from 'lucide-react'
import { IconAtom } from '../_shell/builder-icons'

export const dynamic = 'force-dynamic'
export default function AiAdvertisingPage() {
  return (
    <div className="h10-aia">
      <div className="h10-aia-head">
        <div className="h10-aia-h">
          <span className="ic"><IconAtom size={26} /></span>
          <div>
            <h1>AI Advertising</h1>
            <p>Set a goal and let Product Goal AI manage and optimize your campaigns to reach it.</p>
          </div>
        </div>
        <Link href="/marketing/ads/ai-advertising/new-goal" className="h10-am-btn primary"><Plus size={14} /> New Product Goal</Link>
      </div>

      <div className="h10-aia-empty">
        <span className="ic"><IconAtom size={40} /></span>
        <h2>Get Started with AI Advertising</h2>
        <p>Create a Product Goal and our AI will build, manage, and continuously optimize Sponsored Products campaigns to hit your impressions, sales, or ROAS target — no manual work needed.</p>
        <Link href="/marketing/ads/ai-advertising/new-goal" className="h10-am-btn primary"><Plus size={14} /> New Product Goal</Link>
      </div>
    </div>
  )
}
