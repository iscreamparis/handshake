import { runChecks, testFileCheck } from './lib.ts'
import { displayRating, nextRating, tierOf } from '../../src/store/elo.ts'

const checks = [
  testFileCheck('contract-suite', ['test/store.memory.test.ts'], { minPassed: 25 }),
  {
    label: 'elo-examples',
    async run() {
      const value = `${nextRating(2500, 2500, 1, 0)}/${nextRating(2500, 2500, 0, 0)}, ${nextRating(2500, 2700, 1, 20)}/${nextRating(2700, 2500, 0, 20)}, ${nextRating(10, 10, 0, 20)}`
      const threshold = '2580/2420, 2524/2676, 0'
      return { value, threshold, ok: value === threshold }
    },
  },
  {
    label: 'tiers',
    async run() {
      const value = `${tierOf(1599)}, ${tierOf(1600)}, ${tierOf(2799)}, ${tierOf(3400)}, ${displayRating(499, false)}, ${displayRating(2500, true)}`
      const threshold = 'Bronze, Gold, Platinum, Master, < 500, null'
      return { value, threshold, ok: value === threshold }
    },
  },
]

await runChecks(checks, process.argv.slice(2))
