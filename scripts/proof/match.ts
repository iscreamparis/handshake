import { runChecks, testFileCheck } from './lib.ts'

runChecks([
  testFileCheck('auth', ['test/match.e2e.test.ts'], { minPassed: 1, namePattern: '^auth:' }),
  testFileCheck('quick', ['test/match.e2e.test.ts', 'test/matchmaker.test.ts'], { minPassed: 1, namePattern: '^quick:' }),
  testFileCheck('ranked', ['test/match.e2e.test.ts', 'test/matchmaker.test.ts'], { minPassed: 1, namePattern: '^ranked:' }),
  testFileCheck('result', ['test/match.e2e.test.ts'], { minPassed: 1, namePattern: '^result:' }),
  testFileCheck('forfeit', ['test/match.e2e.test.ts'], { minPassed: 1, namePattern: '^forfeit:' }),
], process.argv.slice(2))
