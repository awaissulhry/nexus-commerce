'use client'

import { useEffect, useRef, useState } from 'react'
import { Lock, Loader2 } from 'lucide-react'
import { Input } from '@/design-system/primitives'
import styles from './styles.module.css'

export function LocationQtyInput({
  value,
  reserved,
  editable,
  locationType,
  saving,
  onCommit,
}: {
  value: number
  reserved: number
  editable: boolean
  locationType: string
  saving: boolean
  onCommit: (value: number) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(String(value))
  const committedRef = useRef(false)

  useEffect(() => {
    if (!editing) setDraft(String(value))
  }, [value, editing])

  // Reset the double-commit guard each time an edit session begins.
  useEffect(() => {
    if (editing) committedRef.current = false
  }, [editing])

  if (!editable) {
    return (
      <span className={styles.invRoLevel} title={`${value} on hand · ${reserved} reserved`}>
        <span className={styles.invNum}>{value}</span>
        {locationType === 'AMAZON_FBA' ? (
          <Lock size={11} className={styles.invLock} aria-label="Amazon-managed, read-only" />
        ) : (
          <span className={styles.invSynced}>synced</span>
        )}
      </span>
    )
  }

  const commit = () => {
    if (committedRef.current) return
    committedRef.current = true
    setEditing(false)
    const n = Number(draft)
    if (Number.isFinite(n) && Number.isInteger(n) && n >= 0 && n !== value) onCommit(n)
    else setDraft(String(value))
  }

  if (editing) {
    return (
      <Input
        type="number"
        min={0}
        autoFocus
        onFocus={(e) => e.currentTarget.select()}
        fieldClassName={styles.invQtyField}
        className={styles.invQtyInput}
        disabled={saving}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
          if (e.key === 'Escape') { setDraft(String(value)); setEditing(false) }
        }}
        aria-label="On-hand quantity"
      />
    )
  }

  return (
    <button
      type="button"
      className={styles.invQtyBtn}
      onClick={() => setEditing(true)}
      title={`${value} on hand · ${reserved} reserved`}
      disabled={saving}
    >
      <span className={styles.invNum}>{value}</span>
      {saving && <Loader2 size={11} className={styles.invSpin} aria-label="Saving" />}
    </button>
  )
}
