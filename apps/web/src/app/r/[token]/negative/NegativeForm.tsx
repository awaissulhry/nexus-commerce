'use client'

import { useState } from 'react'
import { getBackendUrl } from '@/lib/backend-url'

export function NegativeForm({ token }: { token: string }) {
  const [feedback, setFeedback] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (submitting) return
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch(`${getBackendUrl()}/api/r/${encodeURIComponent(token)}/negative`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ feedback }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`)
      setSubmitted(true)
    } catch (e: any) {
      setError(e?.message ?? 'Failed to submit')
    } finally {
      setSubmitting(false)
    }
  }

  if (submitted) {
    return (
      <div style={{
        padding: '24px',
        backgroundColor: '#f0f9f0',
        borderRadius: '8px',
        textAlign: 'center',
        border: '1px solid #c8e6c9',
      }}>
        <div style={{ fontSize: '40px', marginBottom: '8px' }}>✓</div>
        <p style={{ fontSize: '16px', fontWeight: 600, color: '#2e7d32', marginBottom: '8px' }}>
          Grazie. Ti contatteremo presto.
        </p>
        <p style={{ fontSize: '13px', color: '#666' }}>
          Thank you. We&apos;ll be in touch soon.
        </p>
      </div>
    )
  }

  return (
    <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <label htmlFor="feedback" style={{ fontSize: '14px', fontWeight: 500, color: '#333' }}>
        Cosa è andato storto? / What went wrong?
      </label>
      <textarea
        id="feedback"
        value={feedback}
        onChange={(e) => setFeedback(e.target.value)}
        rows={6}
        maxLength={4000}
        autoFocus
        placeholder="Es: il casco non è arrivato in tempo, la taglia non corrisponde, ho ricevuto un articolo sbagliato…"
        style={{
          width: '100%',
          padding: '12px',
          fontSize: '15px',
          fontFamily: 'inherit',
          border: '1px solid #ccc',
          borderRadius: '6px',
          resize: 'vertical',
          minHeight: '120px',
          boxSizing: 'border-box',
        }}
      />
      <button
        type="submit"
        disabled={submitting}
        style={{
          padding: '14px 16px',
          fontSize: '16px',
          fontWeight: 600,
          color: '#fff',
          backgroundColor: submitting ? '#999' : '#c62828',
          border: 'none',
          borderRadius: '6px',
          cursor: submitting ? 'not-allowed' : 'pointer',
        }}
      >
        {submitting ? 'Invio…' : 'Invia / Send'}
      </button>
      {error && (
        <p style={{ fontSize: '13px', color: '#c00', textAlign: 'center' }}>
          {error}
        </p>
      )}
    </form>
  )
}
