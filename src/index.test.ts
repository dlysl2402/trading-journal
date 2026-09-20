import { expect, test } from 'vitest'

import { main } from './index.js'

test('main runs', () => {
  expect(() => main()).not.toThrow()
})
