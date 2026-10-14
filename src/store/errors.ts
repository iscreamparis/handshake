export type StoreErrorCode = 'not_found' | 'bad_argument' | 'insufficient_funds' | 'tx_conflict' | 'no_packs' | 'unknown_product' | 'unknown_reward' | 'unknown_pack' | 'purchase_refunded'

export class StoreError extends Error {
  readonly code: StoreErrorCode

  constructor(code: StoreErrorCode, message: string) {
    super(message)
    this.code = code
    this.name = 'StoreError'
  }
}
