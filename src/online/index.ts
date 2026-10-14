// The online data of one game (= one mission): cloud saves, stats + achievements, player content.
// Everything is over the mission's tables through the tenant table API; the services keep no durable state of their own.

import type { TableApi } from '../store/tables.ts'
import { createSavesService } from '../saves/service.ts'
import type { SavesService } from '../saves/service.ts'
import { createProgressService } from '../achievements/service.ts'
import type { ProgressService } from '../achievements/service.ts'
import { createUgcService } from '../ugc/service.ts'
import type { UgcService } from '../ugc/service.ts'
import { createLimits } from './limits.ts'

export interface OnlineServices { saves: SavesService; progress: ProgressService; ugc: UgcService }

export function createOnline(api: TableApi, opts: { now?: () => number; log?: (level: string, msg: string) => void } = {}): OnlineServices {
  const now = opts.now ?? Date.now
  const limits = createLimits(api, now)
  return {
    saves: createSavesService({ api, limits, now }),
    progress: createProgressService({ api, now, log: opts.log }),
    ugc: createUgcService({ api, limits, now }),
  }
}
