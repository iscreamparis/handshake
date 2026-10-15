// Origin allow-list for WebSocket upgrades. An entry is an exact origin (`https://kart.real3d.fr`) or a
// subdomain wildcard (`https://*.builds.wavedashcdn.com`: any non-empty host label chain under that suffix,
// same scheme, no port unless the entry has one). An empty list allows everything.
export function originAllowed(allowed: readonly string[], origin: unknown): boolean {
  if (allowed.length === 0) return true
  if (typeof origin !== 'string') return false
  if (allowed.includes(origin)) return true
  let url: URL
  try { url = new URL(origin) } catch { return false }
  if (url.origin !== origin) return false
  for (const entry of allowed) {
    const m = /^(https?):\/\/\*\.([a-z0-9.-]+)(:\d+)?$/i.exec(entry)
    if (!m) continue
    if (url.protocol !== `${m[1]!.toLowerCase()}:`) continue
    if ((url.port ? `:${url.port}` : '') !== (m[3] ?? '')) continue
    const suffix = `.${m[2]!.toLowerCase()}`
    if (url.hostname.length > suffix.length && url.hostname.endsWith(suffix)) return true
  }
  return false
}
