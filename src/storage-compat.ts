/**
 * Cross-version SQLite assembly for the global-memory bundle.
 *
 * DSH 0.1.0's Web bundle already mounts the official `sqlite` backend. DSH
 * 0.1.1 keeps the provider package but no longer mounts it. This adapter
 * preserves the host-owned backend when present and supplies the same official
 * provider only when the backend registry has no `sqlite` entry.
 */
import type { Context } from '@deepseek-ai/cordis'
import { storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import type { JournalMode } from '@deepseek-ai/dsh-storage-sqlite'

export const name = 'dsh-global-memory-storage-compat'
export const inject = ['storage']

/** SQLite medium configuration shared by the v1 reuse and v2 fallback paths. */
export interface Config {
  /** Absolute database path, normally `$DSH_HOME/storages/agent-memories.db`. */
  path: string
  /** SQLite journal mode; WAL remains the official provider default. */
  journalMode?: JournalMode
}

/**
 * Reuse the host SQLite backend or mount the official provider when absent.
 * @param ctx - Plugin context with the storage hub available.
 * @param config - SQLite medium configuration for the fallback provider.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  if (ctx.storage.backend.names().includes('sqlite')) return

  const { SqliteStorageBackend } = await import('@deepseek-ai/dsh-storage-sqlite')
  const backend = new SqliteStorageBackend({
    ...config,
    journalMode: config.journalMode ?? 'wal',
  })
  ctx.effect(() => {
    const unregister = ctx.storage.backend.register('sqlite', backend)
    return async () => {
      unregister()
      await backend.close()
    }
  }, 'dsh-global-memory.storageCompat')
  ctx.provide(storageBackendServiceKey('sqlite'), backend)
}
