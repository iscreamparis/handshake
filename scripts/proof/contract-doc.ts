import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runChecks, type CheckResult } from './lib.ts'
import { MATCH_CLIENT_TYPES, MATCH_ERROR_CODES, MATCH_SERVER_TYPES } from '../../src/match/messages.ts'

// sha256 of sections 1-6, computed from docs/CONTRACT.md at 2a9267ac03e5.
const BASE_SECTIONS_SHA256 = '0e19d4235749e13774595294c916bf71919b09e547519880cfb4d69ac5d0c35e'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const contractText = (): string => readFileSync(resolve(repositoryRoot, 'docs/CONTRACT.md'), 'utf8')

// Offset of the first line starting with prefix, or -1.
function lineStart(text: string, prefix: string): number {
  if (text.startsWith(prefix)) return 0
  const index = text.indexOf(`\n${prefix}`)
  return index < 0 ? -1 : index + 1
}

function section7Lines(text: string): string[] {
  const lines = text.split('\n').map((line) => line.replace(/\r$/, ''))
  const start = lines.findIndex((line) => line.startsWith('## 7.'))
  if (start < 0) return []
  const end = lines.findIndex((line, i) => i > start && line === '## Changelog')
  return lines.slice(start + 1, end < 0 ? lines.length : end)
}

function subsection(text: string, heading: string): string[] {
  const lines = section7Lines(text)
  const start = lines.indexOf(heading)
  if (start < 0) return []
  const end = lines.findIndex((line, i) => i > start && (line.startsWith('### ') || line.startsWith('## ')))
  return lines.slice(start + 1, end < 0 ? lines.length : end)
}

function compare(documented: string[], expected: readonly string[], threshold: string, suffix: (extras: number) => string): CheckResult {
  const counts = new Map<string, number>()
  for (const name of documented) counts.set(name, (counts.get(name) ?? 0) + 1)
  const missing = expected.filter((name) => !counts.has(name))
  const extras = documented.filter((name, i) => !expected.includes(name) || documented.indexOf(name) !== i)
  const found = expected.length - missing.length
  let value = `${found}/${expected.length}${suffix(extras.length)}`
  if (missing.length > 0) value += `, missing ${missing.join(',')}`
  if (extras.length > 0) value += `, extra ${extras.join(',')}`
  return { value, threshold, ok: missing.length === 0 && extras.length === 0 }
}

function bulletTypes(heading: string): string[] {
  return subsection(contractText(), heading)
    .map((line) => /^- `([a-z_]+)`/.exec(line)?.[1])
    .filter((name): name is string => name !== undefined)
}

function typeCheck(heading: string, expected: readonly string[]): () => Promise<CheckResult> {
  return async () => compare(bulletTypes(heading), expected, `${expected.length}/${expected.length}, no extras`, () => '')
}

runChecks([
  { label: 'client-types', run: typeCheck('### Client to server', MATCH_CLIENT_TYPES) },
  { label: 'server-types', run: typeCheck('### Server to client', MATCH_SERVER_TYPES) },
  {
    label: 'error-codes',
    run: async () => {
      const codes = subsection(contractText(), '### Error codes')
        .map((line) => /^\|\s*`?([a-z_]+)`?\s*\|/.exec(line)?.[1])
        .filter((code): code is string => code !== undefined && code !== 'code')
      const n = MATCH_ERROR_CODES.length
      return compare(codes, MATCH_ERROR_CODES, `${n}/${n} documented, extras 0`, (extras) => ` documented, extras ${extras}`)
    },
  },
  {
    label: 'sections-1-6',
    run: async () => {
      const text = contractText()
      const start = lineStart(text, '## 1.')
      const end = lineStart(text, '## 7.')
      const threshold = BASE_SECTIONS_SHA256.slice(0, 12)
      if (start < 0 || end < 0 || end < start) return { value: 'section markers not found', threshold, ok: false }
      const hash = createHash('sha256').update(text.slice(start, end), 'utf8').digest('hex')
      return { value: hash.slice(0, 12), threshold, ok: hash === BASE_SECTIONS_SHA256 }
    },
  },
  {
    label: 'revision',
    run: async () => {
      const lines = contractText().split('\n').map((line) => line.replace(/\r$/, ''))
      const header = /\(r3\)\s*$/.test(lines[0] ?? '')
      const changelogStart = lines.indexOf('## Changelog')
      const changelog = changelogStart < 0 ? [] : lines.slice(changelogStart + 1)
      const end = changelog.findIndex((line) => line.startsWith('## '))
      const entries = end < 0 ? changelog : changelog.slice(0, end)
      const r3 = entries.some((line) => line.startsWith('- r2 ')) && entries.some((line) => line.startsWith('- r3 '))
      const r1 = entries.includes('- r1 (2026-10-12): first version.')
      const value = `${header ? 'r3' : 'header not r3'}, ${r3 && r1 ? 'changelog ok' : `changelog r3 ${r3 ? 'ok' : 'missing'}, r1 ${r1 ? 'ok' : 'missing'}`}`
      return { value, threshold: 'r3, changelog ok', ok: header && r1 && r3 }
    },
  },
], process.argv.slice(2))
