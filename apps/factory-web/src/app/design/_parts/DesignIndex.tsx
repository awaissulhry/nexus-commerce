'use client'

import Link from 'next/link'
import { Card } from '@nexus/ui/components'
import { PageHeader } from '@nexus/ui/patterns'
import { Tag } from '@nexus/ui/primitives'
import { DESIGN_SCREENS } from '../_registry'
import '../design.css'

/** `/design` — every screen with fixtures, by SCR id (local only). */
export function DesignIndex() {
  return (
    <main id="main-content" className="fw-design">
      <PageHeader
        eyebrow="Nexus Factory · local only"
        title="Design index"
        subtitle={`${DESIGN_SCREENS.length} screens with made-up data. Open one to see every case in light and dark, desktop and phone.`}
      />
      <div className="fw-design-list">
        {DESIGN_SCREENS.map((screen) => (
          <Card key={screen.screen} padded className="fw-design-card">
            <div className="fw-design-card-head">
              <Tag tone="info">{screen.screen}</Tag>
              <Link className="fw-design-card-title" href={`/design/${screen.screen}`}>
                {screen.title}
              </Link>
            </div>
            <p className="fw-design-muted">{screen.file}</p>
            <ul className="fw-design-cases">
              {screen.cases.map((item) => (
                <li key={item.id}>
                  <Link href={`/design/${screen.screen}#${item.id}`}>{item.label}</Link>
                </li>
              ))}
            </ul>
          </Card>
        ))}
      </div>
    </main>
  )
}
