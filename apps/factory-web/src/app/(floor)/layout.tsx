import type { Metadata, Viewport } from 'next'
import { Noto_Naskh_Arabic } from 'next/font/google'
import type { ReactNode } from 'react'
import { color } from '@nexus/ui/tokens/colors'
import { messagesFor } from '../../lib/i18n/messages'
import { FloorApp } from '../../floor/FloorApp'
import { floorAppVersion } from '../../floor/install'
import { FLOOR_NAMESPACES } from '../../floor/tasks/routes'

/**
 * The Floor view (A2 §1.6; SCR-020 … 025): an enrolled tablet's app under `/floor`, installable (its own web app
 * manifest, `start_url` /floor), on the floor density, with no office chrome. Its text (`floor`, and each floor task's: `floor-tasks`, `floor-scans` …) comes in both
 * languages: the screen speaks the device's language until someone signs in, then the person's (PLT-062), so the
 * client switches without asking the server. Never imports the office view (check-view-boundaries).
 */
export const metadata: Metadata = {
  title: 'Nexus Factory · Floor',
  manifest: '/floor/manifest.webmanifest',
  robots: { index: false, follow: false },
  appleWebApp: { capable: true, title: 'Nexus Floor', statusBarStyle: 'default' },
  icons: { icon: '/floor/icon.svg', apple: '/floor/icon.svg' },
}

export const viewport: Viewport = {
  themeColor: color.primary,
  width: 'device-width',
  initialScale: 1,
  // Gloved hands: + and - buttons zoom where it matters (design "Gloved hands"); the page itself stays put.
  viewportFit: 'cover',
}

/**
 * owb-fl7 (pick J): the Urdu font, loaded by the floor alone and drawn only where the floor speaks Urdu (`:lang(ur)`, floor/floor.css).
 * Noto Naskh Arabic, not Noto Nastaliq Urdu: Nastaliq's tall, sloped line needs about twice the line height, which the floor's fixed
 * 48 / 56 / 64 px controls (and a two-line label: the Urdu word above its small English word) cannot give. Not measured in a browser
 * (Owner rule: checks at the end): the end run measures it at 360 / 390 / 430 px. Not preloaded: a site without Urdu never fetches it.
 */
const urdu = Noto_Naskh_Arabic({ subsets: ['arabic'], display: 'swap', preload: false, fallback: ['serif'] })

export default function FloorLayout({ children }: { children: ReactNode }) {
  // The version this page is served with (B-W2a-42 safe app updates): the tablet runs it until it may take a newer one.
  // owb-fl7: Urdu's words are its drafts over the English ones, key by key (messagesFor('ur', …)).
  return (
    <FloorApp appVersion={floorAppVersion()} urduFont={urdu.style.fontFamily} catalogues={{ it: messagesFor('it', FLOOR_NAMESPACES), en: messagesFor('en', FLOOR_NAMESPACES), ur: messagesFor('ur', FLOOR_NAMESPACES) }}>
      {children}
    </FloorApp>
  )
}
