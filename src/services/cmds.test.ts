import { beforeEach, expect, test, vi } from 'vitest'

import type { ProxyViewV1 } from '@/types/proxy-view'

import { getProxyView } from './cmds'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))

vi.mock('@tauri-apps/api/core', () => ({
  Channel: vi.fn(),
  invoke,
}))
vi.mock('@/services/notice-service', () => ({ showNotice: vi.fn() }))

const ready: ProxyViewV1 = {
  schemaVersion: 1,
  orderSource: 'runtime',
  providerState: 'ready',
  global: null,
  direct: null,
  groups: [],
  records: {},
  standalone: [],
  providers: [],
}

beforeEach(() => invoke.mockReset())

test('rejects transient provider-unavailable snapshots while allowing recovery', async () => {
  invoke
    .mockResolvedValueOnce(ready)
    .mockResolvedValueOnce({ ...ready, providerState: 'unavailable' })
    .mockResolvedValueOnce(ready)

  await expect(getProxyView()).resolves.toBe(ready)
  await expect(getProxyView()).rejects.toThrow(
    'Proxy providers are unavailable',
  )
  await expect(getProxyView()).resolves.toBe(ready)
})

test('preserves a failed core request as a query error', async () => {
  invoke.mockRejectedValueOnce(new Error('core disconnected'))
  await expect(getProxyView()).rejects.toThrow('core disconnected')
})
