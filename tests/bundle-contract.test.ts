import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('../', import.meta.url))
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string
  dependencies: Record<string, string>
  peerDependencies: Record<string, string>
  devDependencies: Record<string, string>
}

describe('public bundle contract', () => {
  it('targets only the published build API and validated source host', () => {
    const dshVersions = '0.1.1-rc.2 || 0.1.2-alpha.1'
    const hostPeers = Object.entries(manifest.peerDependencies)
      .filter(([name]) => name.startsWith('@deepseek-ai/dsh-'))

    expect(root).toBe(fileURLToPath(new URL('../', import.meta.url)))
    expect(manifest.version).toBe('0.2.0')
    expect(manifest.dependencies['@deepseek-ai/dsh-storage-sqlite']).toBe('0.1.1-rc.2')
    expect(hostPeers.length).toBeGreaterThan(0)
    expect(hostPeers.every(([, version]) => version === dshVersions)).toBe(true)
    expect(manifest.devDependencies['@deepseek-ai/dsh-invariants']).toBe(dshVersions)
    for (const [name, version] of hostPeers) {
      expect(manifest.devDependencies[name]).toBe(version)
    }
    expect(manifest.peerDependencies['@deepseek-ai/cordis']).toBe('4.0.1')
    expect(manifest.devDependencies['@deepseek-ai/cordis']).toBe('4.0.1')
  })

  it('does not patch the non-official tool-memory customization', () => {
    const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')

    expect(patch).not.toContain('tool-memory')
    expect(patch).toContain('id: global-memory')
    expect(patch).toContain('id: global-memory-storage-compat')
  })

  it('pins the published rc.2 build-time peer closure for pnpm 11', () => {
    const workspace = readFileSync(new URL('../pnpm-workspace.yaml', import.meta.url), 'utf8')

    expect(workspace).toContain("'@deepseek-ai/dsh-scope': 0.1.1-rc.2")
    expect(workspace).not.toContain('0.1.0-rc.7')
  })
})
