import { test } from 'node:test'
import assert from 'node:assert/strict'

import { main } from './index.ts'

test('main runs', () => {
  assert.doesNotThrow(main)
})
