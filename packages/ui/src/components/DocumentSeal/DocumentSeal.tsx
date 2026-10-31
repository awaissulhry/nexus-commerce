'use client'

/**
 * DocumentSeal — a frozen document's proof (B-W2b-28, design part DocumentSeal): the closed LUL calendar, a payroll
 * export, a DVR version, a statutory check report.
 *
 *   <DocumentSeal title="Calendario LUL · ottobre 2026" version="v1" sha256={doc.sha256} sealedAt="1 nov 2026, 18:02"
 *                 timestampSource="Orologio del server Nexus" sealedBy="Persona Demo" signers={signers} labels={ds.documentSeal} />
 *
 * - Version, the SHA-256 fingerprint (short, and whole in groups of 8 for reading; Copy), when it was sealed and by
 *   which clock, who sealed it, and the signers with their dates ("2 of 4 signed"; a signer without a date waits).
 * - Verify a file: the person picks the file they hold; its SHA-256 is computed ON THIS DEVICE (Web Crypto) and the
 *   answer says "matches" or "does NOT match" with the file's name, an icon and a tone (`documentSealModel.ts`).
 * - Times and names come written from the app (the site's zone and language).
 */
import { useRef, useState, type ChangeEvent, type ReactNode } from 'react'
import { CheckCircle2, Copy, FileCheck2, Hourglass, Lock, XCircle } from 'lucide-react'

import { mergeLabels } from '../../lib/labels'
import { Button } from '../../primitives/Button'
import { DOCUMENT_SEAL_LABELS, type DocumentSealLabels } from './DocumentSealLabels'
import { sealGroups, sealMatches, sealShort, sealSigned, sha256Hex } from './documentSealModel'
import './documentSeal.css'

export interface DocumentSealSigner {
  id: string
  name: string
  /** Employer, RSPP, RLS, occupational doctor. */
  role?: string
  /** When they signed, written in the page's language. Unset: waiting. */
  signedAt?: string | null
}

export interface DocumentSealProps {
  title?: ReactNode
  version: string
  sha256: string
  /** When it was sealed, written in the page's language. */
  sealedAt: string
  /** Which clock gave the time ("Nexus server clock", "Qualified timestamp (TSA)"). */
  timestampSource: string
  sealedBy?: string
  signers?: readonly DocumentSealSigner[]
  /** Offer "Verify a file". Default true. */
  verify?: boolean
  labels?: Partial<DocumentSealLabels>
  id?: string
}

type Check = { kind: 'idle' } | { kind: 'reading'; file: string } | { kind: 'match' | 'mismatch'; file: string } | { kind: 'failed' }

export function DocumentSeal({ title, version, sha256, sealedAt, timestampSource, sealedBy, signers = [], verify = true, labels, id }: DocumentSealProps) {
  const lw = mergeLabels(DOCUMENT_SEAL_LABELS, labels)
  const input = useRef<HTMLInputElement>(null)
  const [check, setCheck] = useState<Check>({ kind: 'idle' })
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle')
  const count = sealSigned(signers)

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.currentTarget.files?.[0]
    e.currentTarget.value = ''
    if (!file) return
    setCheck({ kind: 'reading', file: file.name })
    try {
      const actual = await sha256Hex(await file.arrayBuffer())
      setCheck({ kind: sealMatches(sha256, actual) ? 'match' : 'mismatch', file: file.name })
    } catch {
      setCheck({ kind: 'failed' })
    }
  }

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(sha256)
      setCopy('copied')
    } catch {
      setCopy('failed')
    }
    setTimeout(() => setCopy('idle'), 2500)
  }

  return (
    <section id={id} className="nds-seal" aria-label={lw.region}>
      <div className="nds-seal-head">
        <Lock className="nds-seal-icon" aria-hidden />
        {title ? <div className="nds-seal-title">{title}</div> : null}
        <span className="nds-seal-version">
          {lw.version} {version}
        </span>
      </div>
      <dl className="nds-seal-facts">
        <div className="nds-seal-fact nds-seal-hash">
          <dt>{lw.fingerprint}</dt>
          <dd>
            <code className="nds-seal-code" title={sealShort(sha256)}>
              {sealGroups(sha256)}
            </code>
            <Button size="xs" variant="quiet" onClick={onCopy}>
              <Copy size={14} aria-hidden />
              {copy === 'copied' ? lw.copied : copy === 'failed' ? lw.copyFailed : lw.copy}
            </Button>
          </dd>
        </div>
        <div className="nds-seal-fact">
          <dt>{lw.sealedAt}</dt>
          <dd>{sealedAt}</dd>
        </div>
        <div className="nds-seal-fact">
          <dt>{lw.source}</dt>
          <dd>{timestampSource}</dd>
        </div>
        {sealedBy ? (
          <div className="nds-seal-fact">
            <dt>{lw.sealedBy}</dt>
            <dd>{sealedBy}</dd>
          </div>
        ) : null}
      </dl>
      {signers.length ? (
        <div className="nds-seal-signers">
          <div className="nds-seal-signers-head">
            {lw.signers} · {lw.signedCount(count.signed, count.total)}
          </div>
          <ul>
            {signers.map((s) => (
              <li key={s.id} data-signed={s.signedAt ? 'true' : 'false'}>
                {s.signedAt ? <CheckCircle2 className="nds-seal-signer-icon" aria-hidden /> : <Hourglass className="nds-seal-signer-icon" aria-hidden />}
                <span className="nds-seal-signer-name">{s.name}</span>
                {s.role ? <span className="nds-seal-signer-role">{s.role}</span> : null}
                <span className="nds-seal-signer-when">{s.signedAt ? lw.signedOn(s.signedAt) : lw.waiting}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {verify ? (
        <div className="nds-seal-verify">
          <input ref={input} type="file" className="nds-vh" tabIndex={-1} aria-hidden onChange={onFile} />
          <Button size="sm" onClick={() => input.current?.click()} heldReason={check.kind === 'reading' ? lw.reading : null}>
            <FileCheck2 size={14} aria-hidden />
            {lw.verify}
          </Button>
          <span className="nds-seal-note">{lw.verifyNote}</span>
          <p className="nds-seal-result" role="status" data-result={check.kind}>
            {check.kind === 'reading' ? lw.reading : null}
            {check.kind === 'match' ? (
              <>
                <CheckCircle2 aria-hidden />
                {lw.match(check.file)}
              </>
            ) : null}
            {check.kind === 'mismatch' ? (
              <>
                <XCircle aria-hidden />
                {lw.mismatch(check.file)}
              </>
            ) : null}
            {check.kind === 'failed' ? lw.failed : null}
          </p>
        </div>
      ) : null}
    </section>
  )
}
