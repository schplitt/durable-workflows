import { expect, test } from 'vitest'
import { greet, starter } from '../src'

test('should greet the developer', () => {
  expect(starter).toBe('# Welcome to Your New TypeScript Project!')
  expect(greet('Developer')).toBe('Hello, Developer!')
})
