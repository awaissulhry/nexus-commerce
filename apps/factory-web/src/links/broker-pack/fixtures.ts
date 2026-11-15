import { defineDesignScreen } from '../../lib/design/design-screen'
import type { BrokerPackPage } from './api'
import { initialBrokerModel, type BrokerPackLinkModel } from './model'
import { BrokerPackLinkView } from './view/BrokerPackLinkView'

/**
 * SCR-580 — Export declaration papers (B-W2b-409; LOG-097; the BROKER_PACK link's page for the customs broker). Made-up data
 * only: shipment SH-26-0042 of "Demo Factory S.r.l." to Switzerland, a made-up MRN.
 */

const page = (over: Partial<BrokerPackPage> = {}): BrokerPackPage => ({
  companyName: 'Demo Factory S.r.l.',
  shipment: { number: 'SH-26-0042', country: 'CH' },
  declaration: { status: 'PACK_SENT', mrn: null },
  papers: [
    { fileId: '0190f0e2-5555-7000-8000-000000000001', name: 'Commercial invoice SH-26-0042.pdf', sizeBytes: 48_213, available: true },
    { fileId: '0190f0e2-5555-7000-8000-000000000002', name: 'Packing list SH-26-0042.pdf', sizeBytes: 21_904, available: true },
    { fileId: '0190f0e2-5555-7000-8000-000000000003', name: 'Certificate of origin.pdf', sizeBytes: 130_552, available: true },
    { fileId: '0190f0e2-5555-7000-8000-000000000004', name: 'EU declaration of conformity GP-REPLICA.pdf', sizeBytes: 88_120, available: true },
  ],
  link: { expiresAt: '2026-11-29T09:30:00.000Z' },
  ...over,
})

const model = (over: Partial<BrokerPackLinkModel> = {}, data: Partial<BrokerPackPage> = {}): BrokerPackLinkModel => ({ ...initialBrokerModel, page: page(data), ...over })
const filed = { status: 'FILED' as const, mrn: '26CH00000000000042' }

export const designScreen = defineDesignScreen<BrokerPackLinkModel>({
  screen: 'SCR-580',
  title: 'Export declaration papers (a BROKER_PACK link: download the papers, type the MRN back)',
  view: BrokerPackLinkView,
  cases: [
    { id: 'papers', label: 'The papers to download; the MRN not typed yet', model: model() },
    { id: 'downloading', label: 'Downloading one paper', model: model({ busy: { download: '0190f0e2-5555-7000-8000-000000000001' } }) },
    { id: 'typing', label: 'An MRN being typed: its pattern checked', model: model({ mrn: '26CH0000' }) },
    { id: 'ready', label: 'A whole MRN: Send it', model: model({ mrn: '26CH00000000000042' }) },
    { id: 'sending', label: 'Sending the MRN', model: model({ mrn: '26CH00000000000042', busy: 'mrn' }) },
    { id: 'filed', label: 'Filed: the MRN received, thank you', model: model({}, { declaration: filed }) },
    { id: 'refused', label: 'The MRN was refused: in words', model: model({ mrn: '26CH00000000000043', problem: 'held.FILED' }) },
    { id: 'paper-gone', label: 'A paper withdrawn by the sender', model: model({}, { papers: [{ ...page().papers[0]!, available: false }, page().papers[1]!] }) },
    { id: 'offline', label: 'Offline: the presses held with the reason', model: model({ offline: true, mrn: '26CH00000000000042' }) },
    { id: 'gone', label: 'The declaration was withdrawn: the link opens nothing', model: { ...initialBrokerModel, link: 'unavailable' } },
    { id: 'expired', label: 'The link expired', model: { ...initialBrokerModel, link: 'expired' } },
    { id: 'read-failed', label: 'Could not be opened: Try again', model: { ...initialBrokerModel, problem: 'problem.read' } },
    { id: 'loading', label: 'Loading', model: initialBrokerModel },
  ],
})
