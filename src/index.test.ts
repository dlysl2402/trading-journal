import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'

import { main, summarise } from './index.ts'

const FIXTURE = join(import.meta.dirname, '..', 'ReportHistory-51554919.xlsx')

test('prints usage when given no statement', () => {
  assert.doesNotThrow(() => main())
})

test('summarises an imported statement', () => {
  assert.equal(summarise(FIXTURE), [
    '51554919 · Pepperstone-MT5-Live01 · AUD · hedge',
    '34 trades, 35 closing fills',
    'net 322.81 AUD on 32000.00 deposited',
    '31 trades have no recorded stop at entry',
  ].join('\n'))
})
