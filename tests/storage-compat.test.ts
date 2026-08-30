import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply } from '../src/storage-compat.ts'

describe('storage compatibility adapter', () => {
  it('reuses a SQLite backend already mounted by the host', async () => {
    const effect = vi.fn()
    const provide = vi.fn()
    const ctx = {
      storage: { backend: { names: () => ['json', 'sqlite'] } },
      effect,
      provide,
    } as unknown as Context

    await apply(ctx, { path: ':memory:' })

    expect(effect).not.toHaveBeenCalled()
    expect(provide).not.toHaveBeenCalled()
  })

  it('mounts and disposes the official SQLite provider when absent', async () => {
    const backends = new Map<string, unknown>([['json', {}]])
    let dispose: (() => Promise<void>) | undefined
    const provide = vi.fn()
    const ctx = {
      storage: {
        backend: {
          names: () => [...backends.keys()],
          register: (key: string, backend: unknown) => {
            if (backends.has(key)) throw new Error(`duplicate backend: ${key}`)
            backends.set(key, backend)
            return () => backends.delete(key)
          },
        },
      },
      effect: (register: () => () => Promise<void>) => { dispose = register() },
      provide,
    } as unknown as Context

    await apply(ctx, { path: ':memory:' })

    expect(backends.has('sqlite')).toBe(true)
    expect(provide).toHaveBeenCalledWith('storage.backend.sqlite', backends.get('sqlite'))
    const sqlite = backends.get('sqlite') as {
      kv: { open(descriptor: { name: string; version: number; tables: string[] }): Promise<{ loadAll(): Promise<unknown>; close(): Promise<void> }> }
    }
    const unit = await sqlite.kv.open({ name: 'compat_test', version: 0, tables: ['items'] })
    await expect(unit.loadAll()).resolves.toEqual({ tables: { items: {} }, global: null })
    await unit.close()
    await dispose?.()
    expect(backends.has('sqlite')).toBe(false)
  })
})
