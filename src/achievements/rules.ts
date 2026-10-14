// Event rules of the achievements: `rule_filter` is a small condition list over the payload of a server event,
// "outcome=win,queue=ranked,rating_after>=2800" (all conditions must hold). Operators: = != >= <= > <.
// Numbers are compared as numbers, anything else as strings (= and != only).

export interface Condition { field: string; op: '=' | '!=' | '>=' | '<=' | '>' | '<'; value: string }

const COND = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*(>=|<=|!=|=|>|<)\s*(.*?)\s*$/

/** Parses the filter text; throws on a malformed condition (the backoffice shows the message). */
export function parseFilter(text: string | null | undefined): Condition[] {
  if (text === null || text === undefined || text.trim() === '') return []
  return text.split(',').filter(p => p.trim() !== '').map(part => {
    const m = COND.exec(part)
    if (!m) throw new Error(`bad condition "${part.trim()}"`)
    return { field: m[1]!, op: m[2] as Condition['op'], value: m[3]! }
  })
}

export function matchesFilter(conds: Condition[], payload: Record<string, unknown>): boolean {
  return conds.every(c => {
    const have = payload[c.field]
    if (have === undefined || have === null) return false
    const a = typeof have === 'number' ? have : Number(have)
    const b = Number(c.value)
    const numeric = c.value !== '' && Number.isFinite(b) && (typeof have === 'number' || (String(have) !== '' && Number.isFinite(a)))
    if (numeric) {
      switch (c.op) {
        case '=': return a === b
        case '!=': return a !== b
        case '>=': return a >= b
        case '<=': return a <= b
        case '>': return a > b
        case '<': return a < b
      }
    }
    const s = typeof have === 'boolean' ? String(have) : String(have)
    if (c.op === '=') return s === c.value
    if (c.op === '!=') return s !== c.value
    return false
  })
}
