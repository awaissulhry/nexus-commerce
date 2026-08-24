import { useState } from 'react'
import { Select } from '@nexus/design-system'

/** The styled native `<select>` — the DS supplies the chevron; `<option>`s are yours. */
export const Options = () => {
  const [scope, setScope] = useState('all')
  return (
    <Select value={scope} onChange={(e) => setScope(e.target.value)} aria-label="Campaign scope">
      <option value="all">All campaigns</option>
      <option value="sp">Sponsored Products</option>
      <option value="sb">Sponsored Brands</option>
      <option value="sd">Sponsored Display</option>
    </Select>
  )
}

/** Three labelled selects on one line — the filter-row idiom above a grid. */
export const FilterRow = () => {
  const [marketplace, setMarketplace] = useState('de')
  const [program, setProgram] = useState('sp')
  const [state, setState] = useState('enabled')
  const field = { display: 'flex', flexDirection: 'column' as const, gap: 6 }
  const caption = { fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }
  return (
    <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-end' }}>
      <label style={field}>
        <span style={caption}>Marketplace</span>
        <Select value={marketplace} onChange={(e) => setMarketplace(e.target.value)}>
          <option value="de">Amazon.de</option>
          <option value="it">Amazon.it</option>
          <option value="fr">Amazon.fr</option>
          <option value="es">Amazon.es</option>
        </Select>
      </label>
      <label style={field}>
        <span style={caption}>Program</span>
        <Select value={program} onChange={(e) => setProgram(e.target.value)}>
          <option value="sp">Sponsored Products</option>
          <option value="sb">Sponsored Brands</option>
          <option value="sd">Sponsored Display</option>
        </Select>
      </label>
      <label style={field}>
        <span style={caption}>State</span>
        <Select value={state} onChange={(e) => setState(e.target.value)}>
          <option value="enabled">Enabled</option>
          <option value="paused">Paused</option>
          <option value="archived">Archived</option>
        </Select>
      </label>
    </div>
  )
}

/** With `optgroup`, and `disabled` for a choice the account can&apos;t change. */
export const GroupedAndDisabled = () => {
  const [rule, setRule] = useState('acos-30')
  return (
    <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center' }}>
      <Select value={rule} onChange={(e) => setRule(e.target.value)} aria-label="Budget rule">
        <optgroup label="Budget rules">
          <option value="acos-30">Trim on weak ACoS ≥ 30%</option>
          <option value="spend-cap">Cap spend at €40 / day</option>
        </optgroup>
        <optgroup label="Bid rules">
          <option value="raise-cvr">Raise bids on CVR ≥ 12%</option>
        </optgroup>
      </Select>
      <Select value="eur" disabled aria-label="Billing currency">
        <option value="eur">EUR — set by the ad account</option>
      </Select>
    </div>
  )
}
