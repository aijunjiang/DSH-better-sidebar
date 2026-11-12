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

  it('uses the connection\'s own key when it names one and stores no password', async () => {
    // The connection declares its key: that key is used, and the echo guard
    // travels with it.
    // The key must EXIST: resolveIdentity only answers with a readable PEM.
    const ownKey = join(home, 'own_ed25519')
    await writeFile(ownKey, '-----BEGIN OPENSSH PRIVATE KEY-----\nx\n-----END OPENSSH PRIVATE KEY-----', 'utf8')
    await withConnection({ identityPath: ownKey })
    const { buildRemoteShellBootstrap } = await import('../src/remote-shell.ts')
    const bootstrap = await buildRemoteShellBootstrap(routeCwd('/srv/app'))
    // The harness key is NOT substituted for the connection's chosen auth.
    expect(bootstrap!.command).toContain(`-i '${ownKey}'`)
    expect(bootstrap!.command).not.toContain('sshpass')
    expect(bootstrap!.command).toContain('stty echo 2>/dev/null; exec')
  })

  it('prefers the stored password over any key the harness happens to have', async () => {
    // A harness-provisioned key under <dsh home>/remote-ssh must never be used
    // as a substitute: eleven of the saved connections here are password-only,
    // and a key the target has never seen fails the login outright.
    await withConnection({ password: 'pw' }, '-----BEGIN OPENSSH PRIVATE KEY-----\nx\n-----END OPENSSH PRIVATE KEY-----')
    const { buildRemoteShellBootstrap } = await import('../src/remote-shell.ts')
    const bootstrap = await buildRemoteShellBootstrap(routeCwd('/srv/app'))
    expect(bootstrap!.command).toContain('sshpass -d 3 ssh')
    expect(bootstrap!.command).not.toMatch(/-i '.*id_ed25519'/)
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
