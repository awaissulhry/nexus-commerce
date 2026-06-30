'use client'
import { OpsCanvas } from '../_canvas/OpsCanvas'
import { SAMPLE_OBJECTS } from '../_canvas/sampleData'
import './mission-control.css'

export function MissionControlClient() {
  return (
    <div className="mc-root">
      <header className="mc-head">
        <div className="mc-titlewrap">
          <div className="mc-eyebrow">Nexus Ads</div>
          <h1 className="mc-title">Mission Control</h1>
        </div>
        <div className="mc-actions">
          <span className="mc-chip">All markets</span>
          <span className="mc-chip">Last 30 days</span>
          <span className="mc-chip mc-chip--auto">Autonomy: SUGGEST</span>
          <span className="mc-chip mc-chip--kill">Halt all</span>
        </div>
      </header>
      <div className="mc-body">
        <div className="mc-canvas-wrap">
          <OpsCanvas objects={SAMPLE_OBJECTS} />
        </div>
        <aside className="mc-inspector" aria-label="Inspector">
          <div className="mc-insp-empty">Select an object to inspect</div>
        </aside>
      </div>
    </div>
  )
}
