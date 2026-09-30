import { constants, createWriteStream, type Stats } from 'node:fs'
import { lstat, mkdir, mkdtemp, open, opendir, realpath, rm, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { ImportSkipReason } from '../../shared/filesystem-import-result-types'
import {
  formatByteCeiling,
  REMOTE_IMPORT_MAX_FILE_BYTES,
  REMOTE_IMPORT_MAX_TOTAL_BYTES
} from './runtime-import-limits'

// Why: macOS screenshot thumbnails live in `$TMPDIR/TemporaryItems/NSIRD_*`,
// which only processes attributed to Orca main may open. The detached PTY
// daemon is not, so agents in local terminals get EPERM on the original path.
// See docs/reference/macos-dropped-temp-file-materialization.md.

const TEMPORARY_ITEMS_SEGMENT = 'TemporaryItems'
const DRAG_PROVIDER_DIR_PREFIX = 'NSIRD_'
const COPY_ROOT_NAME = 'orca-drops'
const COPY_DIR_PREFIX = 'orca-drop-'
const COPY_DIR_PATTERN = /^orca-drop-[A-Za-z0-9]{6}$/
// Why: outlives macOS's ~3-day idle temp purge, so drafts and startup prompts
// that read the copy lazily keep working, while still bounding a 2 GiB drop.
export const DRAG_TEMP_COPY_TTL_MS = 7 * 24 * 60 * 60 * 1000

export type DragTempCopyEnvironment = {
  platform: NodeJS.Platform
  /** `os.tmpdir()`: where macOS drag providers put their files. */
  sourceTempRoot: string
  /** Orca-owned directory that holds one `orca-drop-*` directory per copy. */
  copyRoot: string
}

export type LocalDropItemResult =
  | { sourcePath: string; status: 'imported'; destPath: string }
  | { sourcePath: string; status: 'skipped'; reason: ImportSkipReason }
  | { sourcePath: string; status: 'failed'; reason: string }

export function getDragTempCopyRoot(appTempRoot: string): string {
  const uidSuffix = typeof process.getuid === 'function' ? `-${process.getuid()}` : ''
  return join(appTempRoot, `${COPY_ROOT_NAME}${uidSuffix}`)
}

/**
 * Copy every drag-temp path in a drop into Orca-owned storage, sequentially,
 * under one shared byte budget. Other paths pass through unchanged.
 */
export async function materializeDragTempPaths(
  paths: readonly string[],
  env: DragTempCopyEnvironment,
  signal?: AbortSignal
): Promise<LocalDropItemResult[]> {
  const results: LocalDropItemResult[] = []
  const completed = new Map<string, LocalDropItemResult>()
  let remainingBytes = REMOTE_IMPORT_MAX_TOTAL_BYTES
  for (const sourcePath of paths) {
    signal?.throwIfAborted()
    // Why: reuse one copy so composer de-duplication still sees equal paths.
    const previous = completed.get(sourcePath)
    if (previous) {
      results.push(previous)
      continue
    }
    const { result, copiedBytes } = await materializeDragTempPath(
      sourcePath,
      remainingBytes,
      env,
      signal
    )
    remainingBytes -= copiedBytes
    completed.set(sourcePath, result)
    results.push(result)
  }
  return results
}

export async function materializeDragTempPath(
  sourcePath: string,
  remainingBytes: number,
  env: DragTempCopyEnvironment,
  signal?: AbortSignal
): Promise<{ result: LocalDropItemResult; copiedBytes: number }> {
  const passThrough = { result: imported(sourcePath, sourcePath), copiedBytes: 0 }
  if (env.platform !== 'darwin' || !hasDragTempMarker(resolve(sourcePath).split(sep))) {
    return passThrough
  }
  let copyDir: string | undefined
  try {
    let inspected: Stats
    try {
      inspected = await lstat(sourcePath)
    } catch (error) {
      // A missing lookalike outside `$TMPDIR` is still an ordinary path.
      if (
        errorCode(error) === 'ENOENT' &&
        !isPathWithin(resolve(env.sourceTempRoot), resolve(sourcePath))
      ) {
        return passThrough
      }
      throw error
    }
    if (!inspected.isFile()) {
      // Why: directories and symlinks keep today's reference-in-place behaviour.
      return passThrough
    }
    const canonicalSource = await realpath(sourcePath)
    const canonicalTempRoot = await realpath(env.sourceTempRoot)
    if (!hasDragTempMarker(relativeSegments(canonicalTempRoot, canonicalSource))) {
      return passThrough
    }

    const handle = await open(canonicalSource, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const opened = await handle.stat()
      if (!opened.isFile() || !isSameSnapshot(opened, inspected)) {
        throw new DropCopyError('File changed while it was being copied')
      }
      const size = opened.size
      if (size > REMOTE_IMPORT_MAX_FILE_BYTES) {
        throw new DropCopyError(
          `File is ${formatByteCeiling(size)}, over the ` +
            `${formatByteCeiling(REMOTE_IMPORT_MAX_FILE_BYTES)} per-file limit for dropped files`
        )
      }
      if (size > remainingBytes) {
        throw new DropCopyError(
          `Dropped files are over the ${formatByteCeiling(REMOTE_IMPORT_MAX_TOTAL_BYTES)} total limit`
        )
      }
      signal?.throwIfAborted()

      copyDir = await mkdtemp(join(await ensureCopyRoot(env.copyRoot), COPY_DIR_PREFIX))
      const destPath = join(copyDir, basename(canonicalSource))
      // Why: stream from the checked handle, capped at the inspected size;
      // cp/ditto/COPYFILE_ALL would carry com.apple.macl along. An empty
      // source gets its own branch: a read stream with `end: -1` throws.
      await (size === 0
        ? writeFile(destPath, '', { flag: 'wx', mode: 0o600 })
        : pipeline(
            handle.createReadStream({ start: 0, end: size - 1, autoClose: false }),
            createWriteStream(destPath, { flags: 'wx', mode: 0o600 }),
            { signal }
          ))
      const written = await lstat(destPath)
      const afterRead = await handle.stat()
      if (written.size !== size || !isSameSnapshot(afterRead, opened)) {
        throw new DropCopyError('File changed while it was being copied')
      }
      console.debug('[drop] copied a drag-temp file into Orca storage', { bytes: size })
      return { result: imported(sourcePath, destPath), copiedBytes: size }
    } finally {
      await handle.close()
    }
  } catch (error) {
    if (copyDir) {
      // Why: cleanup must not hide the original failure or stop later items.
      await rm(copyDir, { recursive: true, force: true }).catch(() => undefined)
    }
    if (signal?.aborted) {
      throw error
    }
    return { result: classifyFailure(sourcePath, error), copiedBytes: 0 }
  }
}

/** Remove `orca-drop-*` copies older than the TTL; younger ones may still be read lazily. */
export async function sweepExpiredDragTempCopies(
  copyRoot: string,
  nowMs = Date.now()
): Promise<void> {
  try {
    if (!isSafeOwnedDirectory(await lstat(copyRoot))) {
      return
    }
    const dir = await opendir(copyRoot)
    for await (const entry of dir) {
      if (!entry.isDirectory() || !COPY_DIR_PATTERN.test(entry.name)) {
        continue
      }
      const candidate = join(copyRoot, entry.name)
      try {
        const stats = await lstat(candidate)
        if (isSafeOwnedDirectory(stats) && nowMs - stats.mtimeMs >= DRAG_TEMP_COPY_TTL_MS) {
          await rm(candidate, { recursive: true, force: true })
        }
      } catch {
        // Why: one stuck entry must not stop the rest of the sweep.
      }
    }
  } catch {
    // Missing or unreadable root: nothing of ours to sweep.
  }
}

// True when the segments hold `TemporaryItems/NSIRD_*/<entry>`: something below the provider dir.
function hasDragTempMarker(segments: readonly string[]): boolean {
  for (let i = 0; i + 2 < segments.length; i += 1) {
    if (
      segments[i] === TEMPORARY_ITEMS_SEGMENT &&
      segments[i + 1].startsWith(DRAG_PROVIDER_DIR_PREFIX)
    ) {
      return true
    }
  }
  return false
}

/** Path segments of `candidate` below `root`, or [] when it is not inside it. */
function relativeSegments(root: string, candidate: string): string[] {
  const rel = relative(root, candidate)
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return []
  }
  const segments = rel.split(sep)
  // Why: anchor at the temp root so a nested lookalike elsewhere is not copied.
  return segments[0] === TEMPORARY_ITEMS_SEGMENT ? segments : []
}

function isPathWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

async function ensureCopyRoot(copyRoot: string): Promise<string> {
  await mkdir(copyRoot, { recursive: true, mode: 0o700 })
  if (!isSafeOwnedDirectory(await lstat(copyRoot))) {
    throw new DropCopyError('Orca drop storage is not a private directory')
  }
  return copyRoot
}

function isSafeOwnedDirectory(stats: Stats): boolean {
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    return false
  }
  if (typeof process.getuid !== 'function') {
    return true
  }
  return stats.uid === process.getuid() && (stats.mode & 0o077) === 0
}

/** Same inode, size and mtime, where the filesystem reports an inode. */
function isSameSnapshot(a: Stats, b: Stats): boolean {
  return (
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    (a.ino === 0 || b.ino === 0 || a.ino === b.ino) &&
    (a.dev === 0 || b.dev === 0 || a.dev === b.dev)
  )
}

function imported(sourcePath: string, destPath: string): LocalDropItemResult {
  return { sourcePath, status: 'imported', destPath }
}

class DropCopyError extends Error {}

function classifyFailure(sourcePath: string, error: unknown): LocalDropItemResult {
  const code = errorCode(error)
  if (code === 'ENOENT') {
    return { sourcePath, status: 'skipped', reason: 'missing' }
  }
  if (code === 'EPERM' || code === 'EACCES') {
    return { sourcePath, status: 'skipped', reason: 'permission-denied' }
  }
  return { sourcePath, status: 'failed', reason: describeFailure(error, code) }
}

/** Failure copy without the file path, so the renderer can show it as-is. */
function describeFailure(error: unknown, code: string | undefined): string {
  if (error instanceof DropCopyError) {
    return error.message
  }
  if (code) {
    // Why: Node's errno messages end with `, <syscall> '<path>'`.
    const message = error instanceof Error ? error.message.split(', ')[0] : ''
    return message.startsWith(code) ? message : code
  }
  return 'Could not copy the dropped file'
}

function errorCode(error: unknown): string | undefined {
  if (error instanceof Error && 'code' in error && typeof error.code === 'string') {
    return error.code
  }
  return undefined
}
