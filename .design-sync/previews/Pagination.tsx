import { useState } from 'react'
import { Pagination } from '@nexus/design-system'

const Note = ({ children }: { children: React.ReactNode }) => (
  <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-tertiary)' }}>
    {children}
  </div>
)

/** Over 7 pages the list windows to first · last · current±1 with ellipses. Page 9 of 24. */
export const Windowed = () => {
  const [page, setPage] = useState(9)
  return <Pagination page={page} pageCount={24} onPage={setPage} />
}

/** 7 pages or fewer: every page renders, no ellipsis. */
export const ShortRun = () => {
  const [page, setPage] = useState(3)
  return <Pagination page={page} pageCount={6} onPage={setPage} />
}

/** The ends — the previous arrow is disabled on page 1, the next arrow on the last page. */
export const Edges = () => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <Note>First page — prev disabled</Note>
      <Pagination page={1} pageCount={24} onPage={() => {}} />
    </div>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <Note>Last page — next disabled</Note>
      <Pagination page={24} pageCount={24} onPage={() => {}} />
    </div>
  </div>
)

/** Where it actually lives: the grid footer, paired with the row-count line. */
export const GridFooter = () => {
  const [page, setPage] = useState(3)
  const from = (page - 1) * 50 + 1
  const to = Math.min(page * 50, 1180)
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 16,
        flexWrap: 'wrap',
        padding: '10px 14px',
        border: '1px solid var(--border-default)',
        borderRadius: 10,
        background: 'var(--surface-card)',
      }}
    >
      <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
        Viewing <b style={{ color: 'var(--text-primary)' }}>{from}–{to}</b> of{' '}
        <b style={{ color: 'var(--text-primary)' }}>1,180</b> listings
      </span>
      <Pagination page={page} pageCount={24} onPage={setPage} />
    </div>
  )
}
