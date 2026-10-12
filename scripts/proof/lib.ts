import { spawn, type ChildProcess } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface CheckResult { value: string; threshold: string; ok: boolean }
export interface Check { label: string; run(): Promise<CheckResult> }

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const children = new Set<ChildProcess>()

process.on('exit', () => {
  for (const child of children) child.kill()
})

export function parseArgs(argv: string[]): { only: RegExp | null; full: boolean } {
  let only: RegExp | null = null
  let full = false
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--only' && i + 1 < argv.length) only = new RegExp(argv[++i])
    else if (argv[i] === '--full') full = true
  }
  return { only, full }
}

export async function runChecks(checks: Check[], argv: string[]): Promise<never> {
  const { only } = parseArgs(argv)
  const selected = only
    ? checks.filter((check) => {
        only.lastIndex = 0
        return only.test(check.label)
      })
    : checks

  if (selected.length === 0) {
    console.log(`no check matches ${only}`)
    process.exit(2)
  }

  const requested = Number(process.env.NMC_CPUS) || 1
  const concurrency = Number.isFinite(requested) ? Math.max(1, Math.floor(requested)) : 1
  let next = 0
  const worker = async (): Promise<void> => {
    while (true) {
      const index = next++
      if (index >= selected.length) return
      const check = selected[index]
      let result: CheckResult
      try {
        result = await check.run()
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        result = { value: message, threshold: '-', ok: false }
      }
      console.log(`${check.label}: ${result.value} (threshold ${result.threshold}) ${result.ok ? 'PASS' : 'FAIL'}`)
      if (!result.ok) process.exit(1)
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, selected.length) }, () => worker()))
  process.exit(0)
}

function track(child: ChildProcess): void {
  children.add(child)
  child.once('close', () => children.delete(child))
}

export function testFileCheck(
  label: string,
  files: string[],
  opts: { minPassed: number; namePattern?: string; timeoutMs?: number },
): Check {
  return {
    label,
    run: () => new Promise<CheckResult>((resolveResult, rejectResult) => {
      const args = ['--experimental-strip-types', '--test', '--test-reporter=tap']
      if (opts.namePattern !== undefined) args.push(`--test-name-pattern=${opts.namePattern}`)
      args.push(...files)
      const child = spawn(process.execPath, args, { cwd: repositoryRoot, shell: false })
      track(child)
      let stdout = ''
      let stderr = ''
      let settled = false
      const timeoutMs = opts.timeoutMs ?? 120000
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        child.kill()
        resolveResult({ value: `timeout after ${timeoutMs} ms`, threshold: `fail 0, skipped 0, pass >= ${opts.minPassed}`, ok: false })
      }, timeoutMs)
      child.stdout?.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk })
      child.stderr?.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
      child.once('error', (error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        rejectResult(error)
      })
      child.once('close', () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        const passMatch = stdout.match(/^# pass (\d+)\s*$/m)
        if (!passMatch) {
          resolveResult({ value: 'no tap summary', threshold: `fail 0, skipped 0, pass >= ${opts.minPassed}`, ok: false })
          return
        }
        const fail = Number(stdout.match(/^# fail (\d+)\s*$/m)?.[1] ?? 0)
        const skipped = Number(stdout.match(/^# skipped (\d+)\s*$/m)?.[1] ?? 0)
        const pass = Number(passMatch[1])
        resolveResult({
          value: `pass ${pass} fail ${fail} skipped ${skipped}`,
          threshold: `fail 0, skipped 0, pass >= ${opts.minPassed}`,
          ok: fail === 0 && skipped === 0 && pass >= opts.minPassed,
        })
      })
    }),
  }
}

export function spawnCheck(
  label: string,
  cmd: string,
  args: string[],
  opts: { env?: Record<string, string>; timeoutMs?: number; expect: (out: { code: number | null; stdout: string; stderr: string }) => CheckResult },
): Check {
  return {
    label,
    run: () => new Promise<CheckResult>((resolveResult, rejectResult) => {
      const child = spawn(cmd, args, {
        cwd: repositoryRoot,
        env: { ...process.env, ...opts.env },
        shell: false,
      })
      track(child)
      let stdout = ''
      let stderr = ''
      let settled = false
      const timeoutMs = opts.timeoutMs ?? 120000
      const finish = (out: { code: number | null; stdout: string; stderr: string }): void => {
        try {
          resolveResult(opts.expect(out))
        } catch (error) {
          rejectResult(error)
        }
      }
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        child.kill()
        finish({ code: null, stdout, stderr })
      }, timeoutMs)
      child.stdout?.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk })
      child.stderr?.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
      child.once('error', (error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        rejectResult(error)
      })
      child.once('close', (code) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        finish({ code, stdout, stderr })
      })
    }),
  }
}
