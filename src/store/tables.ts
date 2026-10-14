// Table access used by the HTTP player store: the small subset of the CRM generic table API
// (POST /api/tables/{t}, POST /api/tables/{t}/query, PATCH /api/tables/{t}/{id}) the store needs.
// Everything the store writes is append-only; the only update is closing a ranked lock.

export type Row = Record<string, unknown>
export type Filter =
  | { field: string; op: "eq" | "ne"; value: unknown }
  | { field: string; op: "in"; values: unknown[] }
  | { field: string; op: "is_null" | "not_null" }
export interface TableQuery {
  filters?: Filter[]
  sort?: { field: string; dir: "asc" | "desc" }[]
  page?: number
  size?: number
}
export interface TableApi {
  /** Resolves "conflict" when a unique constraint rejects the row (HTTP 409 on the CRM). */
  insert(table: string, row: Row): Promise<{ row: Row } | "conflict">
  query(table: string, q: TableQuery): Promise<Row[]>
  update(table: string, id: number, patch: Row): Promise<void>
}

/** Tables of the EtcitoGameServer tenant ERD. `unique` lists the unique column sets the store relies on
 *  (null values never conflict, which is what makes a closed ranked lock free again). */
export const ETCITO_TABLES: Record<string, { columns: string[]; unique: string[][] }> = {
  etc_players: { columns: ["player_id", "display_name", "kind", "created_at"], unique: [["player_id"]] },
  etc_identities: { columns: ["ident_key", "player_id"], unique: [["ident_key"]] },
  etc_locks: { columns: ["player_id", "match_id", "open_key"], unique: [["open_key"]] },
  etc_ranked_results: { columns: ["match_id", "result_json"], unique: [["match_id"]] },
  etc_rating_events: { columns: ["ev_key", "player_id", "game", "match_id", "r_before", "r_after", "games"], unique: [["ev_key"]] },
  etc_ledger: { columns: ["tx_id", "player_id", "op", "game", "coin_delta", "pack_delta", "params", "result_json", "created_at"], unique: [["tx_id"]] },
  etc_game: { columns: ["code", "name", "repo_url", "repo_branch", "handshake_game", "elo_start", "elo_k_floor", "placement_games", "queues"], unique: [["code"]] },
  etc_publishers: { columns: ["platform", "label", "external_id", "enabled"], unique: [["platform", "external_id"]] },
  etc_settings: { columns: ["key", "value"], unique: [["key"]] },
  etc_wallets: { columns: ["player_id", "coins", "version", "last_ledger_id", "updated_at"], unique: [["player_id"]] },
  etc_cards: { columns: ["player_id", "card_id", "quantity", "ledger_id", "first_at", "updated_at"], unique: [["player_id", "card_id"]] },
  etc_packs: { columns: ["player_id", "pack_type", "quantity", "ledger_id", "updated_at"], unique: [["player_id", "pack_type"]] },
  etc_products: { columns: ["provider", "code", "label", "description", "price", "currency", "grant_coins", "grant_packs", "active", "sort_order", "created_at"], unique: [["provider", "code"]] },
  etc_purchases: { columns: ["provider", "external_id", "player_id", "product_code", "status", "payment_ref", "amount", "currency", "payload", "created_at", "granted_at", "refunded_at"], unique: [["provider", "external_id"]] },
  etc_deploy_runs: { columns: ["run_id", "request_id", "game", "action", "artifact", "build_id", "status", "exit_code", "message", "started_at", "ended_at", "log"], unique: [["run_id"]] },
}

function matches(row: Row, f: Filter): boolean {
  const v = row[f.field]
  switch (f.op) {
    case "eq": return v === f.value
    case "ne": return v !== f.value
    case "in": return f.values.includes(v)
    case "is_null": return v === null || v === undefined
    case "not_null": return v !== null && v !== undefined
  }
}

/** In-memory TableApi enforcing the unique sets: the fake tenant used by tests. */
export function createMemoryTableApi(tables: typeof ETCITO_TABLES = ETCITO_TABLES): TableApi & { rows(table: string): Row[] } {
  const data = new Map<string, Row[]>()
  let nextId = 1
  const rowsOf = (t: string): Row[] => {
    if (!tables[t]) throw new Error(`unknown table ${t}`)
    let r = data.get(t)
    if (!r) { r = []; data.set(t, r) }
    return r
  }
  return {
    rows: t => rowsOf(t),
    async insert(table, row) {
      const rows = rowsOf(table)
      for (const set of tables[table]!.unique) {
        if (set.some(c => row[c] === null || row[c] === undefined)) continue
        if (rows.some(r => set.every(c => r[c] === row[c]))) return "conflict"
      }
      const stored = { ...row, id: nextId++ }
      rows.push(stored)
      return { row: { ...stored } }
    },
    async query(table, q) {
      let out = rowsOf(table).filter(r => (q.filters ?? []).every(f => matches(r, f)))
      for (const s of [...(q.sort ?? [])].reverse()) {
        out = [...out].sort((a, b) => {
          const x = a[s.field] as number | string, y = b[s.field] as number | string
          return (x < y ? -1 : x > y ? 1 : 0) * (s.dir === "asc" ? 1 : -1)
        })
      }
      const size = q.size ?? 50, page = q.page ?? 1
      return out.slice((page - 1) * size, page * size).map(r => ({ ...r }))
    },
    async update(table, id, patch) {
      const rows = rowsOf(table)
      const row = rows.find(r => r.id === id)
      if (!row) throw new Error(`no row ${id} in ${table}`)
      const next = { ...row, ...patch }
      for (const set of tables[table]!.unique) {
        if (set.some(c => next[c] === null || next[c] === undefined)) continue
        if (rows.some(r => r !== row && set.every(c => r[c] === next[c]))) throw new Error("conflict")
      }
      Object.assign(row, patch)
    },
  }
}

/** TableApi over the CRM generic table API with a service key (`gsk_...`). */
export function createCrmTableApi(opts: { baseUrl: string; apiKey: string; fetch?: typeof fetch }): TableApi {
  const f = opts.fetch ?? fetch
  const base = opts.baseUrl.replace(/\/+$/, "")
  const headers = { "content-type": "application/json", authorization: `Bearer ${opts.apiKey}` }
  const url = (t: string, tail = "") => `${base}/api/tables/${encodeURIComponent(t)}${tail}`
  async function fail(res: Response, what: string): Promise<never> {
    throw new Error(`${what}: HTTP ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`)
  }
  return {
    async insert(table, row) {
      const res = await f(url(table), { method: "POST", headers, body: JSON.stringify(row) })
      if (res.status === 409) return "conflict"
      if (!res.ok) return fail(res, `insert ${table}`)
      return { row: (await res.json()) as Row }
    },
    async query(table, q) {
      const body = { filters: q.filters ?? [], sort: q.sort ?? [], page: q.page ?? 1, size: q.size ?? 50 }
      const res = await f(url(table, "/query"), { method: "POST", headers, body: JSON.stringify(body) })
      if (!res.ok) return fail(res, `query ${table}`)
      const json = (await res.json()) as Record<string, unknown>
      // Response envelope to confirm against a live tenant: accept the usual shapes.
      const rows = Array.isArray(json) ? json : (json.records ?? json.rows ?? json.items ?? json.data ?? [])
      return rows as Row[]
    },
    async update(table, id, patch) {
      const res = await f(url(table, `/${id}`), { method: "PATCH", headers, body: JSON.stringify(patch) })
      if (!res.ok) return fail(res, `update ${table}`)
    },
  }
}
