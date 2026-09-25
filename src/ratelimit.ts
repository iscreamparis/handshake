// Token bucket rate limiter driven by an injected clock (ms).

export class TokenBucket {
  ratePerSec: number
  burst: number
  tokens: number
  lastMs: number | null = null
  overSinceMs: number | null = null

  constructor(ratePerSec: number, burst: number) {
    this.ratePerSec = ratePerSec
    this.burst = burst
    this.tokens = burst
  }

  take(nowMs: number): boolean {
    if (this.lastMs !== null && nowMs > this.lastMs) {
      this.tokens = Math.min(this.burst, this.tokens + ((nowMs - this.lastMs) / 1000) * this.ratePerSec)
    }
    if (this.lastMs === null || nowMs > this.lastMs) this.lastMs = nowMs
    if (this.tokens < 1) {
      if (this.overSinceMs === null) this.overSinceMs = nowMs
      return false
    }
    this.tokens -= 1
    this.overSinceMs = null
    return true
  }
}
