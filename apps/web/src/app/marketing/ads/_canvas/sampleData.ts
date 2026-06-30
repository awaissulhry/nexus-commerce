import type { OpsObject } from './types'

// P0 static fixture so the canvas always renders (the dev API has no autopilot
// data). Real ontology wiring lands in P1.
export const SAMPLE_OBJECTS: OpsObject[] = [
  { id: 'de', kind: 'market', name: 'DE · Germany', spend: 1240, acos: 0.22, health: 'ok' },
  { id: 'it', kind: 'market', name: 'IT · Italy', spend: 2980, acos: 0.19, health: 'ok' },
  { id: 'de-moto', kind: 'portfolio', name: 'Moto Jackets', parentId: 'de', spend: 840, acos: 0.24, health: 'ok' },
  { id: 'de-helm', kind: 'portfolio', name: 'Helmets', parentId: 'de', spend: 400, acos: 0.38, health: 'warn' },
  { id: 'aireon', kind: 'campaign', name: 'AIREON Jacket', parentId: 'de-moto', spend: 310, acos: 0.24, health: 'ok' },
  { id: 'misano', kind: 'campaign', name: 'MISANO SP-Auto', parentId: 'de-moto', spend: 190, acos: 0.61, health: 'bad' },
]
