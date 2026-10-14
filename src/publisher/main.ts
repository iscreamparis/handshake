// Publisher entry point. Env: PUBLISHER_KEY (required), PUBLISHER_PORT (9997), PUBLISHER_HOST (127.0.0.1),
// PUBLISHER_DATA (/var/lib/etcito-publisher), PUBLISHER_HOME (= PUBLISHER_DATA/home, the CLI's credential home),
// ETCITO_URL + ETCITO_API_KEY (optional: tenant API + gsk_ key, to mirror runs into etc_deploy_runs),
// WAVEDASH_BIN (wavedash), PUBLISHER_GAMES (JSON path: {"kekkai":{"name":"Kekkai","game_id":"..."}}).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createCrmTableApi } from '../store/tables.ts'
import { createPublisher, type GameConfig } from './runner.ts'
import { createPublisherServer } from './server.ts'

const env = process.env
const dataDir = env.PUBLISHER_DATA ?? '/var/lib/etcito-publisher'
const key = env.PUBLISHER_KEY ?? ''
const gamesPath = env.PUBLISHER_GAMES ?? join(dataDir, 'games.json')
const games = JSON.parse(readFileSync(gamesPath, 'utf8')) as Record<string, GameConfig>

const publisher = createPublisher({
  dataDir, home: env.PUBLISHER_HOME ?? join(dataDir, 'home'), wavedashBin: env.WAVEDASH_BIN ?? 'wavedash', games,
  maxArtifactBytes: Number(env.PUBLISHER_MAX_BYTES ?? 150 * 1024 * 1024), keepArtifacts: 2, runTimeoutMs: 15 * 60_000,
  // Mirror runs into the tenant (etc_deploy_runs) when configured; otherwise the publisher works alone.
  recorder: env.ETCITO_URL && env.ETCITO_API_KEY ? createCrmTableApi({ baseUrl: env.ETCITO_URL, apiKey: env.ETCITO_API_KEY }) : undefined,
})
const server = createPublisherServer(publisher, { key })
const host = env.PUBLISHER_HOST ?? '127.0.0.1'
const port = Number(env.PUBLISHER_PORT ?? 9997)
server.listen(port, host, () => console.log(`publisher listening on ${host}:${port}`))
const stop = (): void => { server.close(); void publisher.idle().then(() => process.exit(0)) }
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
