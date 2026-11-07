'use client'

import { FileText, ImageOff } from 'lucide-react'
import { Card } from '@nexus/ui/components'
import { Button, Skeleton } from '@nexus/ui/primitives'
import { formatNumber } from '../../../lib/i18n/format'
import { useLocale, useT } from '../../../lib/i18n/provider'
import { ProofViewer, type ViewerProof } from '../../../lib/proofs/ProofViewer'
import type { LinkProof } from '../api'
import { proofCode, type QuoteAcceptActions, type QuoteAcceptViewModel } from '../model'

/** A file's size as people read it: "65 KB", "2.4 MB". */
export function sizeText(bytes: number, locale: 'it' | 'en'): string {
  return bytes >= 1024 * 1024
    ? formatNumber(bytes / (1024 * 1024), locale, { style: 'unit', unit: 'megabyte', maximumFractionDigits: 1 })
    : formatNumber(Math.max(1, Math.round(bytes / 1024)), locale, { style: 'unit', unit: 'kilobyte', maximumFractionDigits: 0 })
}

/**
 * SCR-099 "Proofs you accept with it" (design links.quote sec:proofs; SAL-199): the artwork proof, the size chart, the
 * measurement sheet the seller froze with this version — each a tile (a picture's thumbnail, a PDF's mark), its version,
 * size and document code, opening full size in the viewer (Previous / Next over all of them). "You accept these too."
 * A proof that cannot be read says so with Try again; the others stay usable, and answering is still possible.
 */
export function ProofsSection({ proofs, seller, model, actions }: { proofs: readonly LinkProof[]; seller: string; model: QuoteAcceptViewModel; actions?: QuoteAcceptActions }) {
  const t = useT('quote-proofs')
  const locale = useLocale()
  if (proofs.length === 0) return null
  const shown = model.proofs ?? {}
  const viewer: ViewerProof[] = proofs.map((proof) => ({ id: proof.fileId, name: proof.name, shape: proof.shape, versionNo: proof.versionNo, src: shown[proof.fileId]?.src ?? null, problem: shown[proof.fileId]?.problem ?? false }))
  return (
    <Card padded className="fw-qa-card">
      <h2 className="fw-qa-h2">{t('link.title')}</h2>
      <p className="fw-qa-hint">{t('link.hint', { count: proofs.length, seller })}</p>
      <ul className="fw-qa-proofs">
        {proofs.map((proof) => {
          const state = shown[proof.fileId]
          const picture = proof.shape === 'PICTURE'
          return (
            <li key={proof.fileId} className="fw-qa-proof">
              <button type="button" className="fw-qa-proof-open" aria-label={t('link.open', { name: proof.name })} onClick={() => actions?.onProof?.(proof.fileId)}>
                <span className="fw-qa-proof-thumb" aria-hidden>
                  {!picture ? (
                    <FileText size={28} />
                  ) : state?.problem ? (
                    <ImageOff size={24} />
                  ) : typeof state?.src === 'string' ? (
                    <img src={state.src} alt="" />
                  ) : (
                    <Skeleton width="100%" height="100%" />
                  )}
                </span>
                <span className="fw-qa-proof-name">{proof.name}</span>
                <span className="fw-qa-sub">
                  {t(`link.kind.${proof.shape}`)} · {t('link.version', { n: proof.versionNo })} · {sizeText(proof.sizeBytes, locale)}
                </span>
                <span className="fw-qa-sub fw-qa-mono">{t('link.code', { code: proofCode(proof.sha256) })}</span>
              </button>
              {picture && !state && (
                <span className="fw-qa-sub" role="status">
                  {t('link.loading')}
                </span>
              )}
              {state?.problem && (
                <span className="fw-qa-proof-problem" role="status">
                  <span className="fw-qa-sub">{t('link.problem')}</span>
                  <Button size="sm" onClick={() => actions?.onProofRetry?.(proof.fileId)}>
                    {t('link.retry')}
                  </Button>
                </span>
              )}
            </li>
          )
        })}
      </ul>
      <ProofViewer proofs={viewer} openId={model.proofOpen ?? null} onOpen={(id) => actions?.onProof?.(id)} onRetry={(id) => actions?.onProofRetry?.(id)} />
    </Card>
  )
}

/** The proofs named in the end state: what was accepted with the quote (name, version, document code). */
export function AcceptedProofs({ proofs }: { proofs: readonly LinkProof[] }) {
  const t = useT('quote-proofs')
  if (proofs.length === 0) return null
  return (
    <section className="fw-qa-deposit" aria-labelledby="fw-qa-proofs-done">
      <h3 id="fw-qa-proofs-done" className="fw-qa-h3">
        {t('link.accepted')}
      </h3>
      <ul className="fw-qa-proof-list">
        {proofs.map((proof) => (
          <li key={proof.fileId}>
            <span>{proof.name}</span>
            <span className="fw-qa-sub">
              {t('link.version', { n: proof.versionNo })} · <span className="fw-qa-mono">{t('link.code', { code: proofCode(proof.sha256) })}</span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}
