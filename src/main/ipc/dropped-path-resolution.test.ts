import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { PASTE_PAYLOAD_CORPUS } from '../../shared/paste-payload-corpus'
import type { DragTempCopyEnvironment } from './dragged-temp-file-copy'
import { resolveLocalDroppedPathsForAgent } from './dropped-path-resolution'

const { authorizeExternalPath } = vi.hoisted(() => ({ authorizeExternalPath: vi.fn() }))
vi.mock('./filesystem-auth', () => ({ authorizeExternalPath }))

const LINUX_ENV: DragTempCopyEnvironment = {
  platform: 'linux',
  sourceTempRoot: '/tmp',
  copyRoot: '/tmp/orca-drops'
}

async function resolvedPaths(
  paths: string[],
  worktreePath: string | undefined,
  env = LINUX_ENV
): Promise<string[]> {
  const results = await resolveLocalDroppedPathsForAgent(paths, worktreePath, env)
  return results.map((result) => (result.status === 'imported' ? result.destPath : ''))
}

function getPastePayloadCorpusText(name: string): string {
  const entry = PASTE_PAYLOAD_CORPUS.find((item) => item.name === name)
  if (!entry) {
    throw new Error(`Missing paste payload corpus case: ${name}`)
  }
  return entry.text
}

async function withWin32Platform<T>(callback: () => Promise<T>): Promise<T> {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  try {
    return await callback()
  } finally {
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
  }
}

describe('resolveLocalDroppedPathsForAgent', () => {
  it('translates only target-readable Windows paths for local WSL worktrees', async () => {
    const windowsPath = getPastePayloadCorpusText('Windows path with spaces')
    const sameDistroWslPath = getPastePayloadCorpusText('WSL UNC path')
    const otherDistroWslPath = '\\\\wsl.localhost\\Debian\\home\\user\\repo'
    const uncPath = getPastePayloadCorpusText('UNC path')
    const posixPath = getPastePayloadCorpusText('POSIX path with spaces')

    expect(
      await withWin32Platform(() =>
        resolvedPaths(
          [windowsPath, sameDistroWslPath, otherDistroWslPath, uncPath, posixPath],
          '\\\\wsl.localhost\\Ubuntu-24.04\\home\\user\\repo'
        )
      )
    ).toEqual([
      '/mnt/c/Users/Name/My Project/file.txt',
      '/home/user/repo',
      otherDistroWslPath,
      uncPath,
      posixPath
    ])
  })

  it('translates same-distro legacy WSL UNC paths case-insensitively', async () => {
    expect(
      await withWin32Platform(() =>
        resolvedPaths(
          ['\\\\wsl$\\ubuntu-24.04\\home\\user\\repo\\README.md'],
          '\\\\wsl.localhost\\Ubuntu-24.04\\home\\user\\repo'
        )
      )
    ).toEqual(['/home/user/repo/README.md'])
  })

  it('leaves dropped paths unchanged for non-WSL worktrees and with no project path', async () => {
    const paths = ['C:\\Users\\alice\\Desktop\\notes.txt']

    expect(await resolvedPaths(paths, 'C:\\Users\\alice\\repo')).toEqual(paths)
    expect(await resolvedPaths(paths, undefined)).toEqual(paths)
  })

  it('keeps drop order across copies, pass-throughs and failures, and authorizes what it returns', async () => {
    authorizeExternalPath.mockClear()
    const root = await mkdtemp(join(tmpdir(), 'orca-drop-resolution-test-'))
    try {
      const env: DragTempCopyEnvironment = {
        platform: 'darwin',
        sourceTempRoot: root,
        copyRoot: join(root, 'copies')
      }
      const shot = join(root, 'TemporaryItems', 'NSIRD_screencaptureui_1', 'shot.png')
      const missing = join(dirname(shot), 'missing.png')
      const finder = join(root, 'Desktop', 'notes.txt')
      await mkdir(dirname(shot), { recursive: true })
      await writeFile(shot, 'x')

      const results = await resolveLocalDroppedPathsForAgent(
        [finder, missing, shot],
        undefined,
        env
      )

      expect(results[0]).toEqual({ sourcePath: finder, status: 'imported', destPath: finder })
      expect(results[1]).toEqual({ sourcePath: missing, status: 'skipped', reason: 'missing' })
      expect(results[2]).toMatchObject({ sourcePath: shot, status: 'imported' })
      const copy = results[2].status === 'imported' ? results[2].destPath : ''
      expect(copy.startsWith(env.copyRoot)).toBe(true)
      expect(authorizeExternalPath.mock.calls.map(([path]) => path)).toEqual([finder, copy])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
