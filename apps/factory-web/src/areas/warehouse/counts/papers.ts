'use client'

import { storeUrl } from '../../../record-panels/store'
import type { Presigned } from '../../../record-panels/api'

/**
 * The counts' papers in a new tab (design tabs cn-tab-sheets, cn-tab-valued): the count sheets and the valued list's
 * preview are made by the API on request (bytes through the client, so the company header goes with them); the frozen
 * valued list of a signed-off inventory is a stored file (a presigned link). The tab is opened in the click itself, so a
 * pop-up blocker lets it through, and filled once the bytes are there; blocked anyway, the file is downloaded.
 */

const TYPES = { pdf: 'application/pdf', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' } as const

function download(url: string, name: string): void {
  const link = document.createElement('a')
  link.href = url
  link.download = name
  document.body.append(link)
  link.click()
  link.remove()
}

/** A PDF the API makes, in a new tab. Call it straight from the click. */
export async function openPdf(read: () => Promise<Uint8Array>, name: string): Promise<void> {
  const tab = window.open('', '_blank')
  try {
    const bytes = await read()
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: TYPES.pdf }))
    if (tab && !tab.closed) tab.location.href = url
    else download(url, name)
    setTimeout(() => URL.revokeObjectURL(url), 120_000)
  } catch (error) {
    tab?.close()
    throw error
  }
}

/** A spreadsheet the API makes, downloaded. */
export async function saveXlsx(read: () => Promise<Uint8Array>, name: string): Promise<void> {
  const bytes = await read()
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: TYPES.xlsx }))
  download(url, name)
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/** A stored file (the frozen valued list), opened from its presigned link in a new tab. */
export async function openStored(link: () => Promise<Presigned>): Promise<void> {
  const tab = window.open('', '_blank')
  try {
    const presigned = await link()
    const url = storeUrl(presigned.url)
    if (tab && !tab.closed) tab.location.href = url
    else window.location.assign(url)
  } catch (error) {
    tab?.close()
    throw error
  }
}
