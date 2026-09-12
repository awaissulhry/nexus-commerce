'use client'

import { useState } from 'react'
import { Banner, ProgressBar } from '@/design-system/components'
import { Button, SegmentedControl } from '@/design-system/primitives'
import { useStudioScope } from '../contracts'
import { useWorkspaceRead } from '../useWorkspaceRead'
import styles from './analytics.module.css'

interface Performance {
  inventoryAvailable: number | null
  sales: { currency: string | null; units: number; revenue: number; orders: number }[] | null
  prices: { id: string; aliasKey: string; price: number | null; currency: string }[]
  salesNote: string
  observationNote: string
}
const WINDOWS = [{ value: '30', label: '30 days' }, { value: '60', label: '60 days' }, { value: '90', label: '90 days' }]

export function ScopedPerformance() {
  const [days, setDays] = useState('30')
  const { listingId, setListing } = useStudioScope()
  const read = useWorkspaceRead<Performance>('performance', `days=${days}`)
  return <div className={styles.page}>
    <header className={styles.head}><h2 className={styles.title}>Performance</h2><span className={styles.spacer} />
      <SegmentedControl options={WINDOWS} value={days} onChange={setDays} ariaLabel="Reporting window" /></header>
    {read.loading && <ProgressBar indeterminate ariaLabel="Reading performance for the selected destination" />}
    {read.error && <Banner tone="danger">{read.error}</Banner>}
    {read.data && <>
      <section className={styles.card}><h3 className={styles.cardTitle}>Sales</h3>
        <p className={styles.absence}>{read.data.salesNote}</p>
        {listingId && <Button variant="link" onClick={() => setListing()}>Show all listings in this scope</Button>}
        {read.data.sales?.length === 0 && <p>No attributed orders were found in this reporting window.</p>}
        {read.data.sales?.map(row => <dl key={row.currency ?? 'unknown'} className={styles.stats}>
          <div><dt>Units</dt><dd>{row.units}</dd></div><div><dt>Orders</dt><dd>{row.orders}</dd></div>
          <div><dt>Revenue · {row.currency ?? 'currency unknown'}</dt><dd>{row.revenue.toFixed(2)}</dd></div>
        </dl>)}
      </section>
      <section className={styles.card}><h3 className={styles.cardTitle}>Shared inventory</h3>
        <p>Available stock remains owned by inventory across destinations.</p>
        <dl className={styles.stats}><div><dt>Available</dt><dd>{read.data.inventoryAvailable ?? 'Not known'}</dd></div></dl>
      </section>
      <section className={styles.card}><h3 className={styles.cardTitle}>Listing prices</h3>
        {read.data.prices.length === 0 && <p>No listing price is recorded in this scope.</p>}
        <dl className={styles.stats}>{read.data.prices.map(price => <div key={price.id}>
          <dt>{price.aliasKey ? `Customization ${price.aliasKey}` : 'Primary listing'}</dt>
          <dd>{price.price === null ? 'Not known' : `${price.price.toFixed(2)} ${price.currency}`}</dd>
        </div>)}</dl>
      </section>
      <Banner tone="neutral">{read.data.observationNote}</Banner>
    </>}
  </div>
}
