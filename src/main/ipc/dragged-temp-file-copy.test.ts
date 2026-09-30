import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  utimes,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runProcess } from '../../shared/child-process/run-process'
import type * as RuntimeImportLimits from './runtime-import-limits'

vi.mock('./runtime-import-limits', async (importOriginal) => ({
  ...(await importOriginal<typeof RuntimeImportLimits>()),
  REMOTE_IMPORT_MAX_FILE_BYTES: 10,
  REMOTE_IMPORT_MAX_TOTAL_BYTES: 16
}))

import {
  DRAG_TEMP_COPY_TTL_MS,
  materializeDragTempPaths,
  sweepExpiredDragTempCopies,
  type DragTempCopyEnvironment
} from './dragged-temp-file-copy'

const SCREENSHOT_NAME = 'Screenshot 2026-09-28 at 4.03.11 PM.png'
const canChangePermissions = process.platform !== 'win32' && process.getuid?.() !== 0

let root: string
let env: DragTempCopyEnvironment
let providerDir: string

async function dragTempFile(name: string, content: string | Buffer): Promise<string> {
  const filePath = join(providerDir, name)
  await writeFile(filePath, content, { mode: 0o644 })
  return filePath
}

async function copyDirs(): Promise<string[]> {
  try {
    return await readdir(env.copyRoot)
  } catch {
    return []
  }
}

function importedPath(result: { status: string; destPath?: string }): string {
  expect(result.status).toBe('imported')
  return result.destPath!
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-drag-temp-test-'))
  const sourceTempRoot = join(root, 'T')
  providerDir = join(sourceTempRoot, 'TemporaryItems', 'NSIRD_screencaptureui_abc123')
  await mkdir(providerDir, { recursive: true })
  env = { platform: 'darwin', sourceTempRoot, copyRoot: join(root, 'app-temp', 'orca-drops') }
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('materializeDragTempPaths', () => {
  it('copies a drag-temp file, keeping its basename and bytes', async () => {
    const source = await dragTempFile(SCREENSHOT_NAME, 'png-bytes')

    const [result] = await materializeDragTempPaths([source], env)

    const dest = importedPath(result)
    expect(basename(dest)).toBe(SCREENSHOT_NAME)
    expect(basename(dirname(dest))).toMatch(/^orca-drop-/)
    expect(dirname(dirname(dest))).toBe(env.copyRoot)
    expect(await readFile(dest, 'utf8')).toBe('png-bytes')
  })

  it.skipIf(process.platform === 'win32')(
    'creates a 0600 copy in a 0700 directory for a 0644 source',
    async () => {
      const source = await dragTempFile('shot.png', 'x')

      const dest = importedPath((await materializeDragTempPaths([source], env))[0])

      expect((await stat(dest)).mode & 0o777).toBe(0o600)
      expect((await stat(dirname(dest))).mode & 0o777).toBe(0o700)
    }
  )

  it.skipIf(process.platform !== 'darwin')(
    'carries none of the source or provider directory xattrs',
    async () => {
      const source = await dragTempFile('shot.png', 'x')
      for (const target of [source, providerDir]) {
        const set = await runProcess({
          program: '/usr/bin/xattr',
          args: ['-w', 'com.orca.test-marker', '1', target]
        })
        expect(set.code).toBe(0)
      }

      const dest = importedPath((await materializeDragTempPaths([source], env))[0])

      for (const target of [dest, dirname(dest)]) {
        const listed = await runProcess({ program: '/usr/bin/xattr', args: [target] })
        expect(listed.stdout).not.toContain('com.orca.test-marker')
      }
    }
  )

  it('produces an empty copy for a zero-byte source', async () => {
    const source = await dragTempFile('empty.png', '')

    const dest = importedPath((await materializeDragTempPaths([source], env))[0])

    expect((await stat(dest)).size).toBe(0)
  })

  it('passes everything through off macOS', async () => {
    const source = await dragTempFile('shot.png', 'x')

    const results = await materializeDragTempPaths([source], { ...env, platform: 'linux' })

    expect(results).toEqual([{ sourcePath: source, status: 'imported', destPath: source }])
    expect(await copyDirs()).toEqual([])
  })

  it('passes through Finder paths and temp paths outside TemporaryItems/NSIRD_*', async () => {
    const finder = join(root, 'Desktop', 'shot.png')
    const otherTemp = join(env.sourceTempRoot, 'TemporaryItems', 'other', 'shot.png')
    const providerDirItself = providerDir
    await mkdir(dirname(finder), { recursive: true })
    await writeFile(finder, 'x')
    await mkdir(dirname(otherTemp), { recursive: true })
    await writeFile(otherTemp, 'x')

    const paths = [finder, otherTemp, providerDirItself, '/not/there/shot.png']
    const results = await materializeDragTempPaths(paths, env)

    expect(results.map((result) => importedPath(result))).toEqual(paths)
    expect(await copyDirs()).toEqual([])
  })

  it('passes missing TemporaryItems lookalikes outside the configured temp root through', async () => {
    const missing = join(root, 'other', 'TemporaryItems', 'NSIRD_provider', 'gone.png')

    expect(await materializeDragTempPaths([missing], env)).toEqual([
      { sourcePath: missing, status: 'imported', destPath: missing }
    ])
  })

  it.skipIf(process.platform === 'win32')(
    'passes symlinks and directories through unchanged',
    async () => {
      const target = join(root, 'outside.png')
      await writeFile(target, 'x')
      const link = join(providerDir, 'link.png')
      await symlink(target, link)
      const nested = join(providerDir, 'folder')
      await mkdir(nested)

      const results = await materializeDragTempPaths([link, nested], env)

      expect(results.map((result) => importedPath(result))).toEqual([link, nested])
      expect(await copyDirs()).toEqual([])
    }
  )

  it.skipIf(process.platform === 'win32')(
    'treats a symlinked temp root and its real path as the same root',
    async () => {
      const source = await dragTempFile('shot.png', 'x')
      const linkedRoot = join(root, 'var-link')
      await symlink(env.sourceTempRoot, linkedRoot)
      const viaLink = join(linkedRoot, 'TemporaryItems', basename(providerDir), 'shot.png')

      const [throughLinkedSource] = await materializeDragTempPaths([viaLink], env)
      const [throughLinkedRoot] = await materializeDragTempPaths([source], {
        ...env,
        sourceTempRoot: linkedRoot
      })

      expect(importedPath(throughLinkedSource)).not.toBe(viaLink)
      expect(importedPath(throughLinkedRoot)).not.toBe(source)
    }
  )

  it.skipIf(process.platform === 'win32')(
    'does not copy prefix siblings, nested lookalikes, or symlink escapes',
    async () => {
      const sibling = join(`${env.sourceTempRoot}-sibling`, 'TemporaryItems', 'NSIRD_x', 'a.png')
      const nested = join(env.sourceTempRoot, 'deep', 'TemporaryItems', 'NSIRD_x', 'a.png')
      const outsideDir = join(root, 'outside-provider')
      const escaped = join(env.sourceTempRoot, 'TemporaryItems', 'NSIRD_escape', 'a.png')
      for (const filePath of [sibling, nested, join(outsideDir, 'a.png')]) {
        await mkdir(dirname(filePath), { recursive: true })
        await writeFile(filePath, 'x')
      }
      await symlink(outsideDir, dirname(escaped))

      const paths = [sibling, nested, escaped]
      const results = await materializeDragTempPaths(paths, env)

      expect(results.map((result) => importedPath(result))).toEqual(paths)
      expect(await copyDirs()).toEqual([])
    }
  )

  it('reports a missing drag-temp file instead of passing the original through', async () => {
    const missing = join(providerDir, 'gone.png')

    expect(await materializeDragTempPaths([missing], env)).toEqual([
      { sourcePath: missing, status: 'skipped', reason: 'missing' }
    ])
  })

  it.skipIf(!canChangePermissions)(
    'reports an unreadable drag-temp file as permission denied and leaves no copy',
    async () => {
      const source = await dragTempFile('locked.png', 'x')
      await chmod(source, 0o000)

      const results = await materializeDragTempPaths([source], env)

      expect(results).toEqual([
        { sourcePath: source, status: 'skipped', reason: 'permission-denied' }
      ])
      expect(await copyDirs()).toEqual([])
    }
  )

  it('accepts the per-file limit and rejects one byte more without a destination', async () => {
    const atLimit = await dragTempFile('ten.png', '0123456789')
    const overLimit = await dragTempFile('eleven.png', '0123456789a')

    const [accepted, rejected] = await materializeDragTempPaths([atLimit, overLimit], env)

    importedPath(accepted)
    expect(rejected).toEqual({
      sourcePath: overLimit,
      status: 'failed',
      reason: 'File is 11 B, over the 10 B per-file limit for dropped files'
    })
    expect(await copyDirs()).toHaveLength(1)
  })

  it('shares one batch budget, and a rejected item does not block a smaller later one', async () => {
    const finder = join(root, 'big-finder-file.png')
    await writeFile(finder, 'x'.repeat(100))
    const first = await dragTempFile('a.png', '0123456789')
    const second = await dragTempFile('b.png', '0123456789')
    const third = await dragTempFile('c.png', '01234')

    const results = await materializeDragTempPaths([finder, first, second, third], env)

    expect(importedPath(results[0])).toBe(finder)
    importedPath(results[1])
    expect(results[2]).toEqual({
      sourcePath: second,
      status: 'failed',
      reason: 'Dropped files are over the 16 B total limit'
    })
    importedPath(results[3])
    expect(await copyDirs()).toHaveLength(2)
  })

  it('reuses one copy for a duplicate source path within a batch', async () => {
    const source = await dragTempFile('shot.png', 'x')

    const [first, second] = await materializeDragTempPaths([source, source], env)

    expect(importedPath(second)).toBe(importedPath(first))
    expect(await copyDirs()).toHaveLength(1)
  })

  it('gives concurrent batches distinct copy directories', async () => {
    const source = await dragTempFile('shot.png', 'x')

    const [[left], [right]] = await Promise.all([
      materializeDragTempPaths([source], env),
      materializeDragTempPaths([source], env)
    ])

    expect(dirname(importedPath(left))).not.toBe(dirname(importedPath(right)))
    expect(await readFile(importedPath(left), 'utf8')).toBe('x')
    expect(await readFile(importedPath(right), 'utf8')).toBe('x')
  })

  it('stops on abort without leaving a copy behind', async () => {
    const source = await dragTempFile('shot.png', 'x')
    const controller = new AbortController()
    controller.abort(new Error('renderer gone'))

    await expect(materializeDragTempPaths([source], env, controller.signal)).rejects.toThrow(
      'renderer gone'
    )
    expect(await copyDirs()).toEqual([])
  })
})

describe('sweepExpiredDragTempCopies', () => {
  it('removes only expired orca-drop directories', async () => {
    const source = await dragTempFile('shot.png', 'x')
    const [oldCopy] = await materializeDragTempPaths([source], env)
    const [freshCopy] = await materializeDragTempPaths([source], env)
    const oldDir = dirname(importedPath(oldCopy))
    const freshDir = dirname(importedPath(freshCopy))
    const foreign = join(env.copyRoot, 'not-ours')
    await mkdir(foreign)
    const nowMs = Date.now()
    const expired = new Date(nowMs - DRAG_TEMP_COPY_TTL_MS - 1000)
    await utimes(oldDir, expired, expired)
    await utimes(foreign, expired, expired)

    await sweepExpiredDragTempCopies(env.copyRoot, nowMs)

    await expect(lstat(oldDir)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await lstat(freshDir)).isDirectory()).toBe(true)
    expect((await lstat(foreign)).isDirectory()).toBe(true)
  })

  it('does nothing when no copy root exists', async () => {
    await expect(sweepExpiredDragTempCopies(join(root, 'nope'))).resolves.toBeUndefined()
  })
})
