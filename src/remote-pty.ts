/**
 * Remote PTY bridge: the terminal stream contract both node-pty's `IPty`
 * (local shells) and an ssh2 exec channel with an allocated PTY (remote shells)
 * satisfy. When a session's workspace lives on an SSH route, the terminal tab
 * opens a shell ON THE REMOTE HOST in the remote workspace directory — instead
 * of spawning a local node-pty in a directory that only exists as an empty
 * placeholder.
 *
 * The remote shell is `cd <remote-cwd> && exec <shell> <args>` run through
 * remote-ssh's shared connection (`sshRegistry.get(id).getClient().exec(..., { pty }))`,
 * so the terminal rides the same multiplexed SSH connection as file IO without
 * a second TCP connection. Killing the terminal closes only its channel — the
 * shared connection stays alive for the file explorer.
 * @module dsh-better-sidebar/remote-pty
 */

import { posix } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { parseRemoteRoute } from './remote-fs.ts'

/** The terminal stream contract both `IPty` and an SSH channel satisfy. */
export interface SidebarPtyStream {
  onData(listener: (data: string) => void): { dispose(): void }
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void }
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
}

/** The ssh2 `ClientChannel` face the adapter needs (structural, no ssh2 import). */
interface ShellChannel {
  on(event: string, listener: (...args: never[]) => void): void
  off(event: string, listener: (...args: never[]) => void): void
  write(data: string): boolean
  setWindow(rows: number, cols: number, height: number, width: number): void
  close(): void
}

/** The ssh2 `Client` face `SshConnection.getClient()` returns. */
interface ShellClient {
  exec(
    command: string,
    opts: { pty: { rows: number; cols: number; term: string; modes: Record<string, never> } },
    cb: (error: Error | undefined, stream: ShellChannel) => void,
  ): void
}

export interface SshShellConnection {
  getClient(signal?: AbortSignal): Promise<ShellClient>
}

export interface SshShellRegistry {
  get(id: string): SshShellConnection | undefined
}

/** POSIX single-quote for the `cd`/`exec` command. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

/** One SSH-backed terminal: an exec channel with an allocated PTY. */
class SshPtyStream implements SidebarPtyStream {
  private exitCode: number | null = null

  constructor(private readonly channel: ShellChannel) {
    // 'exit' carries the real code; 'close' is the terminal event the onExit
    // listener keys off. Store the code when 'exit' arrives first.
    this.channel.on('exit', ((code: number) => {
      this.exitCode = code
    }) as (...args: never[]) => void)
  }

  onData(listener: (data: string) => void): { dispose(): void } {
    const handler = (data: Buffer | string): void => { listener(data.toString('utf8')) }
    this.channel.on('data', handler as (...args: never[]) => void)
    return { dispose: () => { this.channel.off('data', handler as (...args: never[]) => void) } }
  }

  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void } {
    const handler = (): void => { listener({ exitCode: this.exitCode ?? 0 }) }
    this.channel.on('close', handler as (...args: never[]) => void)
    return { dispose: () => { this.channel.off('close', handler as (...args: never[]) => void) } }
  }

  write(data: string): void {
    this.channel.write(data)
  }

  resize(cols: number, rows: number): void {
    // setWindow(rows, cols, height, width) — pixel dims are 0 (the emulator
    // recomputes them from the cell count on the client side).
    this.channel.setWindow(Math.max(2, Math.floor(rows)), Math.max(2, Math.floor(cols)), 0, 0)
  }

  kill(): void {
    this.channel.close()
  }
}

/**
 * Open a remote login shell in the session's remote workspace directory.
 * @param ctx - cordis context (reads `sshRegistry` from remote-ssh).
 * @param cwd - the session cwd (a remote placeholder / `ssh://` URL).
 * @param cols - initial terminal width.
 * @param rows - initial terminal height.
 * @param shell - remote shell executable (defaults to `/bin/bash`).
 * @param shellArgs - remote shell args (defaults to `['-l']`).
 */
export async function spawnRemoteShell(
  ctx: Context,
  cwd: string,
  cols: number,
  rows: number,
  shell = '/bin/bash',
  shellArgs: string[] = ['-l'],
): Promise<SidebarPtyStream> {
  const route = parseRemoteRoute(cwd)
  if (route === null) throw new Error(`dsh-better-sidebar: not a remote workspace: ${cwd}`)
  const registry = ctx.get('sshRegistry') as SshShellRegistry | undefined
  if (registry === undefined) throw new Error('dsh-better-sidebar: remote-ssh is not mounted')
  const connection = registry.get(route.connectionId)
  if (connection === undefined) throw new Error(`dsh-better-sidebar: unknown connection "${route.connectionId}"`)
  const client = await connection.getClient()
  const args = (shellArgs.length > 0 ? shellArgs : ['-l']).join(' ')
  const command = `cd ${shellQuote(route.remotePath)} && exec ${shellQuote(shell)} ${args}`
  const channel = await new Promise<ShellChannel>((resolve, reject) => {
    client.exec(command, {
      pty: { rows: Math.max(2, Math.floor(rows)), cols: Math.max(2, Math.floor(cols)), term: 'xterm-256color', modes: {} },
    }, (error, stream) => {
      if (error !== undefined) reject(error)
      else resolve(stream)
    })
  })
  return new SshPtyStream(channel)
}
