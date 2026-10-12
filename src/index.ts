// Package entry.

export { createHandshake } from './handshake.ts'
export type { Handshake, HandshakeOptions } from './handshake.ts'
export * from './hooks.ts'
export { loadConfig } from './config.ts'
export type { Config } from './config.ts'
export { startServer } from './server.ts'
export type { ClientConn, HubDeps } from './hub.ts'
export { createMemoryStore } from './store/memory.ts'
export { StoreError } from './store/errors.ts'
export type { StoreErrorCode } from './store/errors.ts'
export type * from './store/types.ts'
export { START_RATING, PLACEMENT_GAMES, expectedScore, kFactor, nextRating, TIERS, tierOf, displayRating } from './store/elo.ts'
