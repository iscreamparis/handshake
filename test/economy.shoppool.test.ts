import test from 'node:test'
import assert from 'node:assert/strict'
import { parseCatalog } from '../src/economy/catalog.ts'
import { cryptoRng, drawRandom, shopPool } from '../src/economy/draw.ts'

const rarities = ['common', 'rare', 'epic', 'legendary']
const cards = Array.from({ length: 60 }, (_, i) => ({
  id: String(i + 1), rarity: rarities[i % 4]!,
  ...(i < 20 ? { source: 'base' } : i < 40 ? { source: 'story' } : i < 45 ? { token: true } : {}),
}))
const PACK = { kind: 'random', size: 5, tiers: rarities, weights: { common: 70, rare: 22, epic: 6.5, legendary: 1.5 }, guarantee: { slot: 'last', min_tier: 'rare' }, duplicate_refund: 5 }
const catalogText = () => JSON.stringify({ cards, packs: { shop: PACK } })

test('parseCatalog keeps the optional source tag; absent stays absent', () => {
  const cat = parseCatalog(catalogText())
  assert.equal(cat.cards.find(c => c.id === '1')!.source, 'base')
  assert.equal(cat.cards.find(c => c.id === '21')!.source, 'story')
  assert.equal('source' in cat.cards.find(c => c.id === '50')!, false)
  assert.throws(() => parseCatalog(JSON.stringify({ cards: [{ id: 'a', rarity: 'common', source: 42 }] })), /bad source/)
})

test('shopPool drops base, story and token cards (default = eligible)', () => {
  const pool = shopPool(parseCatalog(catalogText()).cards)
  assert.deepEqual(pool.map(c => c.id), Array.from({ length: 15 }, (_, i) => String(46 + i)))
})

test('many random draws never return a base / story / token card', () => {
  const cat = parseCatalog(catalogText())
  const pool = shopPool(cat.cards)
  const def = cat.packs.shop!
  const allowed = new Set(pool.map(c => c.id))
  let drawn = 0
  for (let i = 0; i < 5000; i++) {
    const out = drawRandom(def, cryptoRng, pool, new Set())
    assert.equal(out.length, 5)
    for (const c of out) { assert.ok(allowed.has(c.id), `excluded card ${c.id} drawn`); drawn++ }
  }
  assert.equal(drawn, 25000)
})

test('a catalog without any source tag keeps every non-token card in the pool', () => {
  const cat = parseCatalog(JSON.stringify({ cards: [{ id: '1', rarity: 'common' }, { id: '2', rarity: 'rare', token: true }] }))
  assert.deepEqual(shopPool(cat.cards).map(c => c.id), ['1'])
})
