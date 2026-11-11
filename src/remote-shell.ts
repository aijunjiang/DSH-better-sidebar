/**
 * Remote-shell bootstrap: turn an SSH-routed session workspace into ONE shell
 * command the terminal can run to land on the target in the right directory.
 *
 * The bottom terminal is the host's own PTY (`ctx.webTerminals`), which opens a
 * LOCAL shell: the SSH route only ever exists as a placeholder path on this
 * machine. Rather than teaching the terminal service about routes, the sidebar
 * writes a single bootstrap line into the freshly created shell — the same
 * thing a person would type, verified before it runs.
 *
 * Two rules shape this module:
 *
 *  1. **The password never reaches the browser.** The command is assembled on
 *     the host, where the connection records already live, and the client only
 *     receives the finished string. Nothing secret is logged.
 *  2. **Both kinds of route are honoured.** A routed cwd is either
 *     `ssh://<id>/<path>` or the local placeholder
 *     `<dsh home>/dsh-ssh-routes/<id>/<path>`; the remote path is what the
 *     terminal must `cd` into, and it is derived from the same parse the file
 *     bridge uses, so the terminal and the explorer always name one directory.
 *
 * @module dsh-better-sidebar/remote-shell
 */

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseRemoteRoute } from './remote-fs.ts'

/** One saved connection, as `dsh-ssh-connections.json` records it. */
interface SavedConnection {
  id?: string
  label?: string
  host?: string
  port?: number
  username?: string
  password?: string
  identityPath?: string
}

/** The file's shape: `{ connections: [...] }` (a bare array is also tolerated). */
interface ConnectionsFile {
  connections?: SavedConnection[]
}

/** What the client needs to run one bootstrap line. */
export interface RemoteShellBootstrap {
  /** The one-line command to write into the shell, newline included by the caller. */
  readonly command: string
  /** The connection's display label, for the terminal's status text. */
  readonly label: string
  /** The remote directory the shell lands in. */
  readonly remotePath: string
}

/** POSIX single-quote a value for safe interpolation into a shell line. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

/**
 * Locate the connection records of THIS deployment.
 * @returns the parsed file, or an empty list when it is absent or unreadable.
 */
async function readConnections(): Promise<SavedConnection[]> {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const file = join(home, 'dsh-ssh-connections.json')
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as ConnectionsFile | SavedConnection[]
    if (Array.isArray(parsed)) return parsed
    return parsed.connections ?? []
  } catch {
    return []
  }
}

/**
 * Locate a usable private key for one connection.
 *
 * Preference order:
 *  1. the connection's own `identityPath`, when the record names one;
 *  2. the harness-provisioned key under `<dsh home>/remote-ssh/`, which
 *     remote-ssh writes when it bootstraps a connection.
 *
 * Returning a key matters beyond convenience: a KEY-AUTHENTICATED bootstrap
 * command carries no secret at all. Anything typed into a terminal is echoed by
 * the line discipline, so a password — even one hidden with `stty -echo` — must
 * still be written into the input stream to be used. A key needs no such
 * gesture, which is why it is checked first.
 *
 * @param identityPath - the connection's declared key path, when present.
 * @returns an existing private key path, or undefined when none is available.
 */
async function resolveIdentity(identityPath: string): Promise<string | undefined> {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  // A profile that moved $DSH_HOME still shares the machine's credentialed
  // identity directory, so both are searched: the active deployment's first,
  // then the user's default harness home.
  const roots = home === join(homedir(), '.dsh') ? [home] : [home, join(homedir(), '.dsh')]
  const candidates = [
    ...(identityPath === '' ? [] : [identityPath]),
    ...roots.flatMap(root => [join(root, 'remote-ssh', 'id_ed25519'), join(root, 'remote-ssh', 'id_rsa')]),
  ]
  for (const candidate of candidates) {
    try {
      const key = await readFile(candidate, 'utf8')
      // A private key file starts with the PEM marker; anything else is a
      // stray file (a public key, a config) and must not be handed to `ssh -i`.
      if (key.includes('PRIVATE KEY')) return candidate
    } catch {
      // Absent or unreadable: try the next candidate.
    }
  }
  return undefined
}

/**
 * Build the shell line that opens an interactive SSH session on the route's
 * host and lands in the route's remote directory.
 *
 * Password authentication goes through `sshpass -e` (the password travels in
 * the environment, never in argv, so it does not show up in `ps`); a connection
 * with an identity file instead uses `ssh -i`. `-t` forces a TTY so the remote
 * shell is genuinely interactive, and `StrictHostKeyChecking=accept-new` keeps
 * the first connection from blocking on an unknown host key while still
 * refusing a CHANGED one.
 *
 * @param cwd - the session workspace root (placeholder or `ssh://` URL).
 * @returns the bootstrap, or null when the workspace is not on an SSH route.
 */
export async function buildRemoteShellBootstrap(cwd: string): Promise<RemoteShellBootstrap | null> {
  const route = parseRemoteRoute(cwd)
  if (route === null) return null
  const connections = await readConnections()
  const connection = connections.find(candidate => candidate.id === route.connectionId)
  const host = connection?.host ?? ''
  const username = connection?.username ?? ''
  if (host === '' || username === '') return null

  const target = `${username}@${host}`
  const port = connection?.port ?? 22
  const remotePath = route.remotePath === '' ? '/' : route.remotePath
  // The remote directory is interpolated into a DOUBLE-quoted -t argument, so
  // it is quoted remotely as well: the local shell hands `cd '<path>'` to the
  // remote shell unchanged.
  // `clear` runs ON THE TARGET, right before the interactive shell takes over.
  // This is where the bootstrap scaffolding must be erased from: the echo of
  // the ssh line is painted by the LOCAL terminal, and ssh repaints the screen
  // when it attaches, so erasing locally (or clearing afterwards from the
  // client) either misses the echo or wipes the remote prompt too. Clearing on
  // the remote side lands the wipe between those two events, so the shell's own
  // prompt is painted after it and survives.
  const remoteCommand = `clear; cd ${shellQuote(remotePath)}; exec "$SHELL" -l`

  const sshArgs = [
    '-t',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ConnectTimeout=15',
    ...(port === 22 ? [] : ['-p', String(port)]),
  ]

  const identityPath = await resolveIdentity(connection?.identityPath ?? '')
  const password = connection?.password ?? ''
  let command: string
  if (identityPath !== undefined) {
    command = ['ssh', ...sshArgs, '-i', shellQuote(identityPath), target, shellQuote(remoteCommand)].join(' ')
  } else if (password !== '') {
    // SECURITY: the terminal echoes everything written to it, so a password in
    // the command text would sit in the scrollback in clear text — and `clear`
    // only hides it from view, never from the buffer.
    //
    // The first line therefore turns OFF terminal echo before the secret is
    // ever typed, and the LAST line turns it back on. Everything between them
    // is written while the line discipline is not echoing. The password travels
    // through a file descriptor (`sshpass -d 3`), never argv, so it is absent
    // from `ps` too.
    //
    // The leading `stty -echo` must be its own line: echo is a property of the
    // terminal driver, so it can only be changed by a command that already ran.
    command = [
      'stty -echo',
      `exec 3<<<${shellQuote(password)}`,
      `sshpass -d 3 ssh ${sshArgs.join(' ')} ${target} ${shellQuote(remoteCommand)}`,
      'exec 3<&-',
      'stty echo',
    ].join('; ')
  } else {
    command = ['ssh', ...sshArgs, target, shellQuote(remoteCommand)].join(' ')
  }

  return {
    command,
    label: connection?.label ?? target,
    remotePath,
  }
}
