/**
 * The remote-shell bootstrap command: what the bottom terminal types into the
 * fresh local PTY to land on an SSH route's host.
 *
 * This module had NO coverage until a real deployment lost keystroke echo
 * inside the remote shell — the prompt appeared, commands ran, but nothing the
 * user typed was ever echoed back. `stty echo` before the interactive shell
 * takes over is the fix, and these cases pin it: the takeover must not depend
 * on whatever terminal mode the PTY inherited from `clear`'s escape output.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = await mkdtemp(join(tmpdir(), 'remote-shell-spec-'))

/** Write a saved connection into the fake DSH home and point the module at it. */
async function withConnection(
  connection: Record<string, unknown>,
  identity?: string,
): Promise<void> {
  await writeFile(
    join(home, 'dsh-ssh-connections.json'),
    JSON.stringify({ connections: [{ id: 'c1', host: 'h.example', username: 'me', port: 22, ...connection }] }),
    'utf8',
  )
  if (identity !== undefined) {
    await mkdir(join(home, 'remote-ssh'), { recursive: true })
    await writeFile(join(home, 'remote-ssh', 'id_ed25519'), identity, 'utf8')
  }
}

beforeEach(() => {
  vi.stubEnv('DSH_HOME', home)
})

/** The placeholder workspace path of route `c1`. */
function routeCwd(remotePath: string): string {
  return `${home}/dsh-ssh-routes/c1/${remotePath.replace(/^\//, '')}`
}

describe('buildRemoteShellBootstrap', () => {
  it('restores terminal echo on the target before taking over the shell', async () => {
    await withConnection({ password: 'pw' })
    const { buildRemoteShellBootstrap } = await import('../src/remote-shell.ts')
    const bootstrap = await buildRemoteShellBootstrap(routeCwd('/srv/app'))
    expect(bootstrap).not.toBeNull()
    // The exact guarantee: the interactive shell is entered with echo ON,
    // whatever mode `clear` left behind.
    expect(bootstrap!.command).toContain("stty echo 2>/dev/null; exec")
    // ...and `clear` can no longer abort the rest of the line on a target
    // whose terminfo does not know this TERM.
    expect(bootstrap!.command).toContain('clear 2>/dev/null;')
  })

  it('keeps the remote directory quoting intact alongside the echo guard', async () => {
    await withConnection({ password: 'pw' })
    const { buildRemoteShellBootstrap } = await import('../src/remote-shell.ts')
    const bootstrap = await buildRemoteShellBootstrap(routeCwd("/srv/it's here"))
    // The path the terminal must land in survives unescaped in the payload…
    expect(bootstrap!.remotePath).toBe("/srv/it's here")
    // …and the command carries the escaped form (the inner `cd '...'` is
    // itself nested inside the ssh argument's single quotes, so the
    // apostrophe is escaped once for the remote shell and once more for the
    // local one — the shape `'\''\\''\'''` that reaches a shell is valid).
    expect(bootstrap!.command).toContain("cd '\\''/srv/it'")
    expect(bootstrap!.command).toContain('stty echo 2>/dev/null; exec')
  })

  it('uses the identity branch when a key exists, with the same echo guard', async () => {
    await withConnection({}, '-----BEGIN OPENSSH PRIVATE KEY-----\nx\n-----END OPENSSH PRIVATE KEY-----')
    const { buildRemoteShellBootstrap } = await import('../src/remote-shell.ts')
    const bootstrap = await buildRemoteShellBootstrap(routeCwd('/srv/app'))
    expect(bootstrap!.command).toMatch(/^ssh .*-i '.*id_ed25519'/)
    expect(bootstrap!.command).toContain('stty echo 2>/dev/null; exec')
    // The password path must NOT be involved when a key was found.
    expect(bootstrap!.command).not.toContain('sshpass')
  })

  it('answers null for a workspace that is not on an SSH route', async () => {
    await withConnection({ password: 'pw' })
    const { buildRemoteShellBootstrap } = await import('../src/remote-shell.ts')
    await expect(buildRemoteShellBootstrap('/Users/someone/project')).resolves.toBeNull()
  })

  it('answers null when the connection record is missing', async () => {
    await withConnection({ password: 'pw' })
    const { buildRemoteShellBootstrap } = await import('../src/remote-shell.ts')
    await expect(buildRemoteShellBootstrap(`${home}/dsh-ssh-routes/nope/srv`)).resolves.toBeNull()
  })
})
