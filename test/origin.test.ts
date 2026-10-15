import assert from 'node:assert/strict'
import { test } from 'node:test'
import { originAllowed } from '../src/origin.ts'

const A = ['https://kart.real3d.fr', 'https://*.builds.wavedashcdn.com']
test('exact, wildcard, and rejections', () => {
  assert.equal(originAllowed([], undefined), true)
  assert.equal(originAllowed(A, 'https://kart.real3d.fr'), true)
  assert.equal(originAllowed(A, 'https://mx7f-296e-359e.builds.wavedashcdn.com'), true)
  assert.equal(originAllowed(A, 'https://builds.wavedashcdn.com'), false)
  assert.equal(originAllowed(A, 'https://evilbuilds.wavedashcdn.com'), false)
  assert.equal(originAllowed(A, 'https://x.builds.wavedashcdn.com.evil.com'), false)
  assert.equal(originAllowed(A, 'http://x.builds.wavedashcdn.com'), false)
  assert.equal(originAllowed(A, 'https://x.builds.wavedashcdn.com:8443'), false)
  assert.equal(originAllowed(A, undefined), false)
  assert.equal(originAllowed(A, 'null'), false)
})
