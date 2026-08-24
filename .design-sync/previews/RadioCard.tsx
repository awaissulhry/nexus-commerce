import { useState } from 'react'
import { RadioCard } from '@nexus/design-system'

/** The targeting-type picker this card was built for. `selected` paints the `.on` highlight —
 *  pass it alongside the radio's own `checked`. */
export const TargetingType = () => {
  const [type, setType] = useState('auto')
  return (
    <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
      <RadioCard
        name="targeting"
        title="Automatic"
        description="Amazon targets relevant searches for you"
        selected={type === 'auto'}
        checked={type === 'auto'}
        onChange={() => setType('auto')}
      />
      <RadioCard
        name="targeting"
        title="Manual"
        description="You choose keywords & products"
        selected={type === 'manual'}
        checked={type === 'manual'}
        onChange={() => setType('manual')}
      />
    </div>
  )
}

const PROGRAMS = [
  { id: 'sp', title: 'Sponsored Products', desc: 'Keyword and product targeting on the search page. The only program native budget rules support.' },
  { id: 'sb', title: 'Sponsored Brands', desc: 'Headline banner with your logo and up to three ASINs. Needs Brand Registry.' },
  { id: 'sd', title: 'Sponsored Display', desc: 'Retargeting on and off Amazon, billed on vCPM or CPC.' },
]

/** Stacked full-width cards — the wizard step where the description carries the decision. */
export const CampaignType = () => {
  const [program, setProgram] = useState('sp')
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 460 }}>
      {PROGRAMS.map((p) => (
        <RadioCard
          key={p.id}
          name="program"
          title={p.title}
          description={p.desc}
          selected={program === p.id}
          checked={program === p.id}
          onChange={() => setProgram(p.id)}
        />
      ))}
    </div>
  )
}

/** Title-only cards, no `description` — the compact form for a short list of modes. */
export const TitleOnly = () => {
  const [pacing, setPacing] = useState('even')
  return (
    <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
      <RadioCard name="pacing" title="Even pacing" selected={pacing === 'even'} checked={pacing === 'even'} onChange={() => setPacing('even')} />
      <RadioCard name="pacing" title="Fast delivery" selected={pacing === 'fast'} checked={pacing === 'fast'} onChange={() => setPacing('fast')} />
      <RadioCard name="pacing" title="Dayparted" selected={pacing === 'day'} checked={pacing === 'day'} onChange={() => setPacing('day')} />
    </div>
  )
}
