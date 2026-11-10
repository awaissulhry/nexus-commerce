'use client'

import { coverageState, documentsOf, MATRIX_DOCUMENTS, shownLanguages, type MatrixCoverage, type MatrixData, type MatrixDocument } from './model'
import './language-matrix.css'

/** The part's words, in the page's language (the caller's catalogue). */
export interface LanguageMatrixWords {
  /** The table's name for assistive technology. */
  readonly label: string
  readonly market: string
  /** One letter (or two) per document, and its full name. */
  readonly short: Readonly<Record<MatrixDocument, string>>
  readonly long: Readonly<Record<MatrixDocument, string>>
  readonly off: string
  readonly none: string
  readonly coverageRow: string
  /** "{ready} of {total} ready" etc. */
  readonly coverage: (coverage: MatrixCoverage) => string
  readonly noCoverage: string
  readonly legend: string
  readonly empty: string
}

/**
 * LanguageMatrix — which language each market needs for which document (L label · D declaration of conformity · U user
 * information), the switched-off markets dimmed and said, and, under the table, per language how many phrases of the library
 * are ready to print (complete, waiting for a second person, missing or stale: a word and a tone, never colour alone). A plain
 * table that scrolls inside its own box on a phone (the page never scrolls sideways); the first column stays in view.
 */
export function LanguageMatrix({ data, coverage, words, languageName, onlySwitchedOn = false }: { data: MatrixData; coverage?: readonly MatrixCoverage[] | null; words: LanguageMatrixWords; languageName: (tag: string) => string; onlySwitchedOn?: boolean }) {
  const languages = shownLanguages(data, onlySwitchedOn)
  if (data.markets.length === 0 || languages.length === 0) return <p className="fw-lm-empty">{words.empty}</p>
  return (
    <div className="fw-lm">
      <div className="fw-lm-scroll" role="region" aria-label={words.label} tabIndex={0}>
        <table className="fw-lm-table">
          <caption className="fw-lm-vh">{words.label}</caption>
          <thead>
            <tr>
              <th scope="col" className="fw-lm-first">
                {words.market}
              </th>
              {languages.map((language) => (
                <th key={language} scope="col">
                  <span className="fw-lm-lang">{language.toUpperCase()}</span>
                  <span className="fw-lm-lang-name">{languageName(language)}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.markets.map((market) => (
              <tr key={market.code} className={market.switchedOn ? undefined : 'fw-lm-off'}>
                <th scope="row" className="fw-lm-first">
                  <span className="fw-lm-code">{market.code}</span> {market.name}
                  {!market.switchedOn && <span className="fw-lm-offword"> · {words.off}</span>}
                </th>
                {languages.map((language) => {
                  const documents = documentsOf(market, language)
                  return (
                    <td key={language}>
                      {documents.length === 0 ? (
                        <span className="fw-lm-none" aria-label={words.none}>
                          —
                        </span>
                      ) : (
                        <span className="fw-lm-docs" aria-label={documents.map((document) => words.long[document]).join(', ')}>
                          {documents.map((document) => (
                            <abbr key={document} className="fw-lm-doc" title={words.long[document]}>
                              {words.short[document]}
                            </abbr>
                          ))}
                        </span>
                      )}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
          {coverage && (
            <tfoot>
              <tr>
                <th scope="row" className="fw-lm-first">
                  {words.coverageRow}
                </th>
                {languages.map((language) => {
                  const entry = coverage.find((item) => item.language === language)
                  const state = coverageState(entry)
                  return (
                    <td key={language} className={`fw-lm-cov is-${state}`}>
                      {entry ? words.coverage(entry) : words.noCoverage}
                    </td>
                  )
                })}
              </tr>
            </tfoot>
          )}
        </table>
      </div>
      <p className="fw-lm-legend">
        {words.legend}{' '}
        {MATRIX_DOCUMENTS.map((document) => (
          <span key={document} className="fw-lm-legend-item">
            <abbr className="fw-lm-doc" title={words.long[document]}>
              {words.short[document]}
            </abbr>{' '}
            {words.long[document]}
          </span>
        ))}
      </p>
    </div>
  )
}
