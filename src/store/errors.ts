export type StoreErrorCode =
  | 'not_found' | 'bad_argument' | 'insufficient_funds' | 'tx_conflict' | 'no_packs' | 'unknown_product' | 'unknown_reward' | 'unknown_pack' | 'purchase_refunded'
  // saves / achievements / stats / ugc
  | 'version_conflict' | 'too_large' | 'quota_exceeded' | 'forbidden' | 'rate_limited' | 'unknown_stat' | 'stat_not_writable'

export class StoreError extends Error {
  readonly code: StoreErrorCode
  /** Extra data for the caller (e.g. the server copy of a save on `version_conflict`). */
  readonly detail: unknown

  constructor(code: StoreErrorCode, message: string, detail?: unknown) {
    super(message)
    this.code = code
    this.detail = detail
    this.name = 'StoreError'
  }
}
