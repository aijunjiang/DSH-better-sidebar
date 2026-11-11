/**
 * Remote workspace filesystem bridge.
 *
 * When a session's workspace lives on an SSH route (dsh-remote-ssh), the
 * sidebar's file operations must run over SFTP instead of `node:fs`. The
 * workspace cwd is a LOCAL PLACEHOLDER (`<dsh-home>/dsh-ssh-routes/<id>/<path>`)
 * that exists only so paths stay valid on the host — the real bytes live on the
 * remote host. This module detects the route from the placeholder (or an
 * `ssh://<id>/<path>` URL), resolves remote-ssh's `sshRegistry` service from the
 * cordis tree, and exposes SFTP-backed list/read/write/stat/mkdir primitives
 * that mirror the local `node:fs` behaviour closely enough for the file
 * explorer and editor.
 *
 * The DISPLAY path stays the placeholder — better-sidebar's tree, breadcrumbs,
 * editor tabs and diff views all keep using it consistently — while the REMOTE
 * path is only used for SFTP calls. Without remote-ssh mounted, every helper
 * returns `null` and the local `node:fs` path is used unchanged.
 * @module dsh-better-sidebar/remote-fs
 */

import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createWriteStream } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, posix } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { SidebarFsEntry } from './fs-tree.ts'
import { SidebarError } from './wire.ts'

/** One parsed remote route. */
export interface RemoteRoute {
  connectionId: string
  remotePath: string
}

/** SFTP subset remote-ssh's `SshConnection.getSftp()` exposes. */
export interface SftpLike {
  readdir(path: string, cb: (err: Error | null, entries: Array<{ filename: string; attrs: SftpAttrsLike }>) => void): void
  readFile(path: string, cb: (err: Error | null, data: Buffer) => void): void
  writeFile(path: string, data: Buffer, cb: (err: Error | null) => void): void
  stat(path: string, cb: (err: Error | null, stats: SftpAttrsLike) => void): void
  lstat(path: string, cb: (err: Error | null, stats: SftpAttrsLike) => void): void
  mkdir(path: string, cb: (err: Error | null) => void): void
  rename(oldPath: string, newPath: string, cb: (err: Error | null) => void): void
  unlink(path: string, cb: (err: Error | null) => void): void
  rmdir(path: string, cb: (err: Error | null) => void): void
  fastPut(localPath: string, remotePath: string, cb: (err: Error | null) => void): void
}

/** ssh2 `Stats` subset used here. */
export interface SftpAttrsLike {
  isDirectory(): boolean
  isSymbolicLink(): boolean
  isFile(): boolean
  size: number
  mtime: number
}

export interface SshConnectionLike {
  getSftp(signal?: AbortSignal): Promise<SftpLike>
}

export interface SshRegistryLike {
  get(id: string): SshConnectionLike | undefined
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** remote-ssh's connection registry (optional — absent without remote-ssh). */
    sshRegistry?: SshRegistryLike
  }
}

const SSH_PREFIX = 'ssh://'
const PLACEHOLDER = 'dsh-ssh-routes/'

/** Detect a remote route from a workspace path (placeholder or `ssh://` URL). */
export function parseRemoteRoute(path: string): RemoteRoute | null {
  if (path.startsWith(SSH_PREFIX)) {
    const rest = path.slice(SSH_PREFIX.length)
    const sep = rest.indexOf('/')
    if (sep <= 0) return null
    return { connectionId: rest.slice(0, sep), remotePath: rest.slice(sep) || '/' }
  }
  const idx = path.indexOf(PLACEHOLDER)
  if (idx >= 0) {
    const after = path.slice(idx + PLACEHOLDER.length)
    const sep = after.indexOf('/')
    if (sep <= 0) return null
    return { connectionId: after.slice(0, sep), remotePath: after.slice(sep) || '/' }
  }
  return null
}

/** The placeholder prefix of a remote path, used to map remote paths back to display paths. */
function placeholderPrefix(path: string): string | null {
  if (path.startsWith(SSH_PREFIX)) {
    const rest = path.slice(SSH_PREFIX.length)
    const sep = rest.indexOf('/')
    if (sep > 0) return path.slice(0, SSH_PREFIX.length + sep)
    return null
  }
  const idx = path.indexOf(PLACEHOLDER)
  if (idx >= 0) {
    const after = path.slice(idx + PLACEHOLDER.length)
    const sep = after.indexOf('/')
    if (sep > 0) return path.slice(0, idx + PLACEHOLDER.length + sep)
    return null
  }
  return null
}

/** Resolve the SFTP handle + route for a workspace path, or null when local/unavailable. */
export async function remoteSftp(ctx: Context, path: string): Promise<{ sftp: SftpLike; route: RemoteRoute; toDisplay: (remote: string) => string } | null> {
  const route = parseRemoteRoute(path)
  if (route === null) return null
  const registry = ctx.get('sshRegistry') as SshRegistryLike | undefined
  if (registry === undefined) return null
  const connection = registry.get(route.connectionId)
  if (connection === undefined) return null
  const sftp = await connection.getSftp()
  const prefix = placeholderPrefix(path)
  return {
    sftp,
    route,
    toDisplay: (remote: string) => (prefix === null ? remote : `${prefix}${remote}`),
  }
}

/** Promise wrapper for SFTP readdir. */
function sftpReaddir(sftp: SftpLike, path: string): Promise<Array<{ filename: string; attrs: SftpAttrsLike }>> {
  return new Promise((resolve, reject) => {
    sftp.readdir(path, (error, entries) => {
      if (error !== undefined) reject(error)
      else resolve(entries)
    })
  })
}

/** Promise wrapper for SFTP readFile. */
function sftpReadFile(sftp: SftpLike, path: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    sftp.readFile(path, (error, data) => {
      if (error !== undefined) reject(error)
      else resolve(data)
    })
  })
}

/** Promise wrapper for SFTP stat. */
function sftpStat(sftp: SftpLike, path: string, kind: 'stat' | 'lstat' = 'stat'): Promise<SftpAttrsLike> {
  return new Promise((resolve, reject) => {
    const cb = (error: Error | null, stats: SftpAttrsLike): void => {
      if (error !== undefined) reject(error)
      else resolve(stats)
    }
    if (kind === 'lstat') sftp.lstat(path, cb)
    else sftp.stat(path, cb)
  })
}

/** Promise wrapper for SFTP mkdir. */
function sftpMkdir(sftp: SftpLike, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.mkdir(path, (error) => {
      if (error !== undefined) reject(error)
      else resolve()
    })
  })
}

/** Promise wrapper for SFTP rename. */
function sftpRename(sftp: SftpLike, oldPath: string, newPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.rename(oldPath, newPath, (error) => {
      if (error !== undefined) reject(error)
      else resolve()
    })
  })
}

/** Promise wrapper for SFTP unlink. */
function sftpUnlink(sftp: SftpLike, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.unlink(path, (error) => {
      if (error !== undefined) reject(error)
      else resolve()
    })
  })
}

/** Promise wrapper for SFTP rmdir. */
function sftpRmdir(sftp: SftpLike, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.rmdir(path, (error) => {
      if (error !== undefined) reject(error)
      else resolve()
    })
  })
}

/** Promise wrapper for SFTP fastPut (pipelined local→remote bulk upload). */
function sftpFastPut(sftp: SftpLike, localPath: string, remotePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.fastPut(localPath, remotePath, (error) => {
      if (error !== undefined) reject(error)
      else resolve()
    })
  })
}

/**
 * Recursively create a remote directory, treating an already-existing
 * directory as success. SFTP `mkdir` is non-recursive and reports a failure
 * (not `EEXIST`) for existing paths, so each level is created then verified
 * with `stat` when creation fails.
 */
async function ensureRemoteDirs(sftp: SftpLike, dir: string): Promise<void> {
  if (dir === '' || dir === '/' || dir === '.') return
  const parts = dir.split('/').filter(Boolean)
  let current = dir.startsWith('/') ? '' : '.'
  for (const part of parts) {
    current = current === '' ? `/${part}` : current === '.' ? part : `${current}/${part}`
    try {
      await sftpMkdir(sftp, current)
    } catch (error) {
      try {
        const stats = await sftpStat(sftp, current)
        if (!stats.isDirectory()) throw error
      } catch {
        throw error
      }
    }
  }
}

/**
 * Stream `chunks` into a local staging file, bounded by `limit`, mirroring the
 * local upload path's chunked write (never buffers a whole file in memory, so
 * multi-gigabyte uploads stay bounded). Returns the written byte count.
 */
async function stageLocalUpload(chunks: AsyncIterable<string | Uint8Array>, target: string, limit: number): Promise<number> {
  const stream = createWriteStream(target, { flags: 'wx' })
  const closed = new Promise<void>((resolve) => { stream.once('close', () => resolve()) })
  let size = 0
  let streamError: unknown
  stream.on('error', (error) => { streamError = error })
  try {
    for await (const chunk of chunks) {
      const buffer = Buffer.from(chunk)
      size += buffer.length
      if (size > limit) throw new SidebarError('too-large', `upload exceeds the ${limit} byte limit`, 413)
      if (!stream.write(buffer)) await once(stream, 'drain')
      if (streamError !== undefined) throw streamError
    }
    await new Promise<void>((resolve, reject) => {
      stream.end((error?: Error | null) => (error === undefined || error === null ? resolve() : reject(error)))
    })
    if (streamError !== undefined) throw streamError
    return size
  } catch (error) {
    stream.destroy()
    await closed.catch(() => {})
    await rm(target, { force: true }).catch(() => {})
    throw error
  }
}

/** List one remote directory level as explorer rows (display paths stay placeholders). */
export async function listRemoteDirectory(toDisplay: (remote: string) => string, sftp: SftpLike, remotePath: string, maxEntries = 1000): Promise<{ entries: SidebarFsEntry[]; truncated: boolean }> {
  const listed = await sftpReaddir(sftp, remotePath)
  const rows: SidebarFsEntry[] = []
  let truncated = false
  for (const entry of listed) {
    const name = entry.filename
    if (name === '.' || name === '..') continue
    if (rows.length >= maxEntries) { truncated = true; break }
    const attrs = entry.attrs
    let isDir = attrs.isDirectory()
    const isSymlink = attrs.isSymbolicLink()
    let broken = false
    // Resolve symlink targets so a directory symlink expands like a directory.
    if (isSymlink && !isDir) {
      try {
        const stats = await sftpStat(sftp, posix.join(remotePath, name))
        isDir = stats.isDirectory()
        broken = !stats.isDirectory() && !stats.isFile()
      } catch {
        broken = true
      }
    }
    rows.push({
      name,
      path: toDisplay(posix.join(remotePath, name)),
      isDir,
      isSymlink,
      broken,
      hidden: name.startsWith('.'),
    })
  }
  return { entries: rows, truncated }
}

/** Read a remote text file (bounded), mirroring `readText`'s result shape. */
export async function readRemoteText(ctx: Context, path: string, readLimit: number): Promise<{
  content: string
  truncated: boolean
  binary: boolean
  size: number
  head?: string
}> {
  const resolved = await remoteSftp(ctx, path)
  if (resolved === null) throw new Error(`dsh-better-sidebar: remote path not resolvable: ${path}`)
  const { sftp, route } = resolved
  const stats = await sftpStat(sftp, route.remotePath)
  if (stats.isDirectory()) throw new Error(`"${path}" is a directory`)
  const size = stats.size
  const truncated = size > readLimit
  const data = await sftpReadFile(sftp, route.remotePath)
  const slice = data.subarray(0, Math.min(size, readLimit))
  const binary = slice.includes(0)
  const head = binary
    ? slice.subarray(0, Math.min(slice.length, 256)).toString('base64')
    : undefined
  return {
    content: binary ? '' : slice.toString('utf8'),
    truncated,
    binary,
    size,
    head,
  }
}

/** Read a remote file's raw bytes (media route: images, etc.). */
export async function readRemoteBytes(ctx: Context, path: string): Promise<{ data: Buffer; size: number; isFile: boolean }> {
  const resolved = await remoteSftp(ctx, path)
  if (resolved === null) throw new Error(`dsh-better-sidebar: remote path not resolvable: ${path}`)
  const { sftp, route } = resolved
  const stats = await sftpStat(sftp, route.remotePath)
  const data = await sftpReadFile(sftp, route.remotePath)
  return { data, size: stats.size, isFile: stats.isFile() }
}

/** Write a remote text file (unconditional overwrite; SFTP v3 semantics). */
export async function writeRemoteText(ctx: Context, path: string, content: string): Promise<void> {
  const resolved = await remoteSftp(ctx, path)
  if (resolved === null) throw new Error(`dsh-better-sidebar: remote path not resolvable: ${path}`)
  await new Promise<void>((resolve, reject) => {
    resolved.sftp.writeFile(resolved.route.remotePath, Buffer.from(content, 'utf8'), (error) => {
      if (error !== undefined) reject(error)
      else resolve()
    })
  })
}

/** Create a remote directory (non-recursive; parent must exist). */
export async function mkdirRemote(ctx: Context, path: string): Promise<void> {
  const resolved = await remoteSftp(ctx, path)
  if (resolved === null) throw new Error(`dsh-better-sidebar: remote path not resolvable: ${path}`)
  await sftpMkdir(resolved.sftp, resolved.route.remotePath)
}

/**
 * Remove one remote path. A directory is emptied first — SFTP `rmdir` refuses a
 * non-empty one, and the local `rm(recursive)` behaviour the caller expects has
 * no single SFTP equivalent — then removed bottom-up.
 * @param ctx - cordis context carrying remote-ssh's `sshRegistry`.
 * @param path - the placeholder or `ssh://` path naming the remote entry.
 */
export async function removeRemote(ctx: Context, path: string): Promise<void> {
  const resolved = await remoteSftp(ctx, path)
  if (resolved === null) throw new Error(`dsh-better-sidebar: remote path not resolvable: ${path}`)
  await removeRemotePath(resolved.sftp, resolved.route.remotePath)
}

/** Recursively remove one remote path through SFTP. */
async function removeRemotePath(sftp: SftpLike, remotePath: string, depth = 0): Promise<void> {
  // A depth bound keeps a symlink cycle (or a pathological tree) from recursing
  // without end; 64 levels is deeper than any real workspace.
  if (depth > 64) throw new Error(`dsh-better-sidebar: refusing to recurse below ${remotePath}`)
  const stats = await sftpStat(sftp, remotePath, 'lstat')
  if (!stats.isDirectory()) {
    await sftpUnlink(sftp, remotePath)
    return
  }
  const listed = await sftpReaddir(sftp, remotePath)
  for (const entry of listed) {
    if (entry.filename === '.' || entry.filename === '..') continue
    await removeRemotePath(sftp, posix.join(remotePath, entry.filename), depth + 1)
  }
  await sftpRmdir(sftp, remotePath)
}

/**
 * Rename or move one remote path. SFTP refuses to overwrite an existing target,
 * so the caller keeps its own existence check.
 * @param ctx - cordis context carrying remote-ssh's `sshRegistry`.
 * @param from - the source path (placeholder or `ssh://`).
 * @param to - the destination path, in the same spelling as `from`.
 */
export async function renameRemote(ctx: Context, from: string, to: string): Promise<void> {
  const source = await remoteSftp(ctx, from)
  if (source === null) throw new Error(`dsh-better-sidebar: remote path not resolvable: ${from}`)
  // The destination is resolved through the SOURCE connection: a rename never
  // crosses from one SSH host to another.
  const destination = parseRemoteRoute(to)
  if (destination === null) throw new Error(`dsh-better-sidebar: remote path not resolvable: ${to}`)
  await sftpRename(source.sftp, source.route.remotePath, destination.remotePath)
}

/** Create one remote directory (non-recursive; the parent must exist). */
export async function mkdirRemoteEntry(ctx: Context, path: string): Promise<void> {
  const resolved = await remoteSftp(ctx, path)
  if (resolved === null) throw new Error(`dsh-better-sidebar: remote path not resolvable: ${path}`)
  await sftpMkdir(resolved.sftp, resolved.route.remotePath)
}

/** Create one empty remote file, refusing an existing target (the local `wx` flag). */
export async function createRemoteFile(ctx: Context, path: string): Promise<void> {
  const resolved = await remoteSftp(ctx, path)
  if (resolved === null) throw new Error(`dsh-better-sidebar: remote path not resolvable: ${path}`)
  let exists = false
  try {
    await sftpStat(resolved.sftp, resolved.route.remotePath, 'lstat')
    exists = true
  } catch {
    // Absent is the expected answer; a live transport failure surfaces from the
    // write below instead of being misread as "no such file".
  }
  if (exists) {
    const error = new Error(`EEXIST: file already exists, open '${path}'`) as NodeJS.ErrnoException
    error.code = 'EEXIST'
    throw error
  }
  await new Promise<void>((resolve, reject) => {
    resolved.sftp.writeFile(resolved.route.remotePath, Buffer.alloc(0), (error) => {
      if (error !== undefined) reject(error)
      else resolve()
    })
  })
}

/** Whether one remote path exists, answering like `lstat` would. */
export async function remoteEntryExists(ctx: Context, path: string): Promise<boolean> {
  const resolved = await remoteSftp(ctx, path)
  if (resolved === null) return false
  try {
    await sftpStat(resolved.sftp, resolved.route.remotePath, 'lstat')
    return true
  } catch {
    return false
  }
}

/**
 * Upload `chunks` into a remote (SFTP) workspace target atomically. The bytes
 * are first streamed to a local staging file (bounded chunks, so GB-scale
 * uploads never buffer a whole file in memory), then pushed to the remote with
 * `fastPut` (ssh2's pipelined bulk transfer) into a temp sibling and renamed
 * over the target. Parent directories are created on demand. The display path
 * stays a placeholder for the client, while the bytes land on the SSH host.
 *
 * @throws SidebarError with a wire code for shape, size, and SFTP failures;
 * the staging file and remote temp file are always removed on failure.
 */
export async function writeRemoteUpload(
  ctx: Context,
  target: string,
  chunks: AsyncIterable<string | Uint8Array>,
  limit: number,
): Promise<{ path: string; size: number }> {
  const resolved = await remoteSftp(ctx, target)
  if (resolved === null) throw new SidebarError('fs-error', `cannot upload to remote path: ${target}`, 400)
  const { sftp, route } = resolved
  const remoteTarget = route.remotePath
  await ensureRemoteDirs(sftp, posix.dirname(remoteTarget))
  const remoteTmp = `${remoteTarget}.dsh-upload-${randomUUID()}.tmp`
  const stageDir = await mkdtemp(join(tmpdir(), 'dsh-sidebar-upload-'))
  const stagePath = join(stageDir, 'upload.bin')
  try {
    const size = await stageLocalUpload(chunks, stagePath, limit)
    await sftpFastPut(sftp, stagePath, remoteTmp)
    await sftpRename(sftp, remoteTmp, remoteTarget)
    return { path: target, size }
  } catch (error) {
    await sftpUnlink(sftp, remoteTmp).catch(() => {})
    throw error
  } finally {
    await rm(stageDir, { recursive: true, force: true }).catch(() => {})
  }
}
