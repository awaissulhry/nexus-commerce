'use client'

import { usePieceRates } from './use-piecerates'
import { PieceRatesView } from './view/PieceRatesView'

/**
 * `/w/<company>/people/piecerates` (SCR-158): the legal switch first; rate tables and versions, the scheme; once piece pay has
 * been on, pay periods, the earnings ledger and held scans. The address holds the rate filter (`?tile=`, `?rates=all`, `?q=`),
 * the records open in their modals (`?open=` a rate version, `?period=`, `?resolve=` a held scan, `?entry=`) and the ledger's
 * filters; the site is the top bar's.
 */
export function PieceRatesPage() {
  const { model, actions } = usePieceRates()
  return <PieceRatesView model={model} actions={actions} />
}
