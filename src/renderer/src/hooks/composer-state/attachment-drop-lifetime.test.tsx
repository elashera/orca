// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { createRef, StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ResolveDroppedPathsResult } from '../../../../shared/filesystem-import-result-types'
import type { NativeFileDropPayload } from '../../../../shared/native-file-drop'
import { useAttachmentDropState } from './attachment-drop-state'

const mocks = vi.hoisted(() => ({ toastError: vi.fn() }))
vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))
vi.mock('@/store', () => ({ useAppStore: { getState: () => ({}) } }))
vi.mock('@/runtime/runtime-file-client', () => ({ importExternalPathsToRuntime: vi.fn() }))

const listeners = new Set<(data: NativeFileDropPayload) => void>()
const passThrough = async ({ paths }: { paths: string[] }): Promise<ResolveDroppedPathsResult> => ({
  resolvedPaths: paths,
  skipped: [],
  failed: []
})
const resolveDrop = vi.fn(passThrough)
const stat = vi.fn(async (_input: { filePath: string }) => ({ isDirectory: false }))
let originalApi: PropertyDescriptor | undefined

function holdResolveUntil(gate: Promise<unknown>): void {
  resolveDrop.mockImplementationOnce(async (input) => {
    await gate
    return passThrough(input)
  })
}

function renderDrop(
  strict = false,
  { selectedRepoPath }: { selectedRepoPath?: string } = { selectedRepoPath: '/folder-workspace' }
) {
  const attach = vi.fn()
  const prompt = vi.fn()
  const hook = renderHook(
    () =>
      useAttachmentDropState({
        agentPromptRef: { current: '' },
        cancelPromptCaretFrame: () => {},
        connectionId: null,
        promptCaretFrameRef: { current: null },
        promptTextareaRef: createRef<HTMLTextAreaElement>(),
        selectedRepoPath,
        selectedRepoSettings: null,
        setAgentPrompt: prompt,
        setAttachmentPaths: attach
      }),
    { wrapper: strict ? StrictMode : undefined }
  )
  return { ...hook, attach, prompt }
}

function nativeDrop(paths: string[]): void {
  for (const listener of listeners) {
    listener({ target: 'composer', paths })
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  resolveDrop.mockReset().mockImplementation(passThrough)
  stat.mockReset().mockResolvedValue({ isDirectory: false })
  originalApi = Object.getOwnPropertyDescriptor(window, 'api')
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      fs: { resolveDroppedPathsForAgent: resolveDrop, stat },
      ui: {
        onFileDrop: (listener: (data: NativeFileDropPayload) => void) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        }
      }
    }
  })
})

afterEach(() => {
  cleanup()
  expect(listeners.size).toBe(0)
  if (originalApi) {
    Object.defineProperty(window, 'api', originalApi)
  } else {
    Reflect.deleteProperty(window, 'api')
  }
})

describe('local composer drop lifetime', () => {
  it.each(['resolve', 'stat'] as const)(
    'stops a large batch after unmount during %s',
    async (phase) => {
      const gate = Promise.withResolvers<void>()
      if (phase === 'resolve') {
        holdResolveUntil(gate.promise)
      } else {
        stat.mockImplementationOnce(async () => {
          await gate.promise
          return { isDirectory: false }
        })
      }
      const hook = renderDrop()
      const paths = Array.from({ length: 1000 }, (_, index) => `/drop/item-${index}`)
      const pending = hook.result.current.applyLocalComposerDrop(paths)
      await vi.waitFor(() =>
        expect(phase === 'resolve' ? resolveDrop : stat).toHaveBeenCalledOnce()
      )
      hook.unmount()
      gate.resolve()
      await pending

      expect(resolveDrop).toHaveBeenCalledOnce()
      expect(stat).toHaveBeenCalledTimes(phase === 'resolve' ? 0 : 1)
      expect(hook.attach).not.toHaveBeenCalled()
      expect(hook.prompt).not.toHaveBeenCalled()
      expect(mocks.toastError).not.toHaveBeenCalled()
    }
  )

  it.each(['resolve', 'stat'] as const)(
    'stops silently when a held %s fails after unmount',
    async (phase) => {
      const gate = Promise.withResolvers<never>()
      if (phase === 'resolve') {
        resolveDrop.mockImplementationOnce(() => gate.promise)
      } else {
        stat.mockImplementationOnce(() => gate.promise)
      }
      const hook = renderDrop()
      const pending = hook.result.current.applyLocalComposerDrop(['/drop/one', '/drop/two'])
      await vi.waitFor(() =>
        expect(phase === 'resolve' ? resolveDrop : stat).toHaveBeenCalledOnce()
      )
      hook.unmount()
      gate.reject(new Error('EACCES: no access'))
      await pending

      expect(resolveDrop).toHaveBeenCalledOnce()
      expect(stat).toHaveBeenCalledTimes(phase === 'resolve' ? 0 : 1)
      expect(hook.attach).not.toHaveBeenCalled()
      expect(mocks.toastError).not.toHaveBeenCalled()
    }
  )

  it('does no work through a callback saved before unmount', async () => {
    const hook = renderDrop()
    const applyDrop = hook.result.current.applyLocalComposerDrop
    hook.unmount()
    await applyDrop(['/drop/late'])

    expect(resolveDrop).not.toHaveBeenCalled()
    expect(stat).not.toHaveBeenCalled()
    expect(hook.attach).not.toHaveBeenCalled()
  })

  it('resolves the whole drop once, keeps order, filters duplicates and reports once', async () => {
    const paths = ['/drop/one', '/drop/folder', '/drop/missing', '/drop/two', '/drop/one']
    resolveDrop.mockResolvedValueOnce({
      resolvedPaths: ['/drop/one', '/drop/folder', '/drop/two', '/drop/one'],
      skipped: [{ sourcePath: '/drop/missing', reason: 'missing' }],
      failed: []
    })
    stat.mockImplementation(async ({ filePath }) => ({ isDirectory: filePath === '/drop/folder' }))
    const hook = renderDrop()
    await hook.result.current.applyLocalComposerDrop(paths)

    expect(resolveDrop).toHaveBeenCalledExactlyOnceWith({ paths })
    expect(stat.mock.calls.map(([input]) => input.filePath)).toEqual([
      '/drop/one',
      '/drop/folder',
      '/drop/two',
      '/drop/one'
    ])
    expect(hook.attach).toHaveBeenCalledOnce()
    expect(hook.attach.mock.calls[0]?.[0](['/existing'])).toEqual([
      '/existing',
      '/drop/one',
      '/drop/two'
    ])
    expect(hook.prompt).toHaveBeenCalledWith('/drop/folder')
    expect(mocks.toastError).toHaveBeenCalledExactlyOnceWith(
      '1 of 5 items could not be attached.',
      { id: 'composer-drop-failure', description: 'No longer at its original path.' }
    )
  })

  it('attaches the copy main returns and never the original drag-temp path', async () => {
    const original = '/var/folders/x/T/TemporaryItems/NSIRD_screencaptureui_1/shot.png'
    const copy = '/var/folders/x/T/orca-drops-501/orca-drop-abc123/shot.png'
    resolveDrop.mockResolvedValueOnce({ resolvedPaths: [copy], skipped: [], failed: [] })
    const hook = renderDrop()
    await hook.result.current.applyLocalComposerDrop([original])

    expect(hook.attach.mock.calls[0]?.[0]([])).toEqual([copy])
    expect(stat).toHaveBeenCalledExactlyOnceWith({ filePath: copy })
  })

  it('combines resolver and stat failures into one accurately counted toast', async () => {
    resolveDrop.mockResolvedValueOnce({
      resolvedPaths: ['/drop/ok', '/drop/vanished'],
      skipped: [{ sourcePath: '/drop/locked', reason: 'permission-denied' }],
      failed: [{ sourcePath: '/drop/huge', reason: 'File is 3 GB, over the 2 GB per-file limit' }]
    })
    stat.mockImplementation(async ({ filePath }) => {
      if (filePath === '/drop/vanished') {
        throw new Error('ENOENT: gone')
      }
      return { isDirectory: false }
    })
    const hook = renderDrop()
    await hook.result.current.applyLocalComposerDrop([
      '/drop/ok',
      '/drop/locked',
      '/drop/huge',
      '/drop/vanished'
    ])

    expect(hook.attach.mock.calls[0]?.[0]([])).toEqual(['/drop/ok'])
    expect(mocks.toastError).toHaveBeenCalledExactlyOnceWith(
      '3 of 4 items could not be attached.',
      { id: 'composer-drop-failure', description: undefined }
    )
  })

  it('reports a rejected resolver call as a failure for every dropped path', async () => {
    resolveDrop.mockRejectedValueOnce(new Error('EACCES: denied'))
    const hook = renderDrop()
    await hook.result.current.applyLocalComposerDrop(['/drop/a', '/drop/b'])

    expect(stat).not.toHaveBeenCalled()
    expect(hook.attach).not.toHaveBeenCalled()
    expect(mocks.toastError).toHaveBeenCalledExactlyOnceWith(
      '2 of 2 items could not be attached.',
      { id: 'composer-drop-failure', description: 'Permission denied.' }
    )
  })
})

describe('native composer ownership during a local drop', () => {
  it.each([false, true])(
    'stops after actual listener cleanup (Strict Mode: %s)',
    async (strict) => {
      const gate = Promise.withResolvers<void>()
      holdResolveUntil(gate.promise)
      const hook = renderDrop(strict)
      act(() => nativeDrop(['/drop/one', '/drop/two']))
      await vi.waitFor(() => expect(resolveDrop).toHaveBeenCalledOnce())
      hook.unmount()
      expect(listeners.size).toBe(0)
      await act(async () => gate.resolve())

      expect(resolveDrop).toHaveBeenCalledOnce()
      expect(stat).not.toHaveBeenCalled()
      expect(hook.attach).not.toHaveBeenCalled()
    }
  )

  it('continues while temporarily covered and applies if ownership returns', async () => {
    const first = Promise.withResolvers<void>()
    const second = Promise.withResolvers<void>()
    holdResolveUntil(first.promise)
    stat.mockImplementationOnce(async () => ({ isDirectory: false }))
    stat.mockImplementationOnce(async () => {
      await second.promise
      return { isDirectory: false }
    })
    const older = renderDrop()
    act(() => nativeDrop(['/drop/one', '/drop/two']))
    await vi.waitFor(() => expect(resolveDrop).toHaveBeenCalledOnce())
    const newer = renderDrop()
    await act(async () => first.resolve())
    expect(stat).toHaveBeenCalledTimes(2)
    expect(older.attach).not.toHaveBeenCalled()
    newer.unmount()
    await act(async () => second.resolve())

    expect(older.attach).toHaveBeenCalledOnce()
    expect(newer.attach).not.toHaveBeenCalled()
  })

  it('withholds a completed drop while a newer owner remains mounted', async () => {
    const gate = Promise.withResolvers<void>()
    holdResolveUntil(gate.promise)
    const older = renderDrop()
    act(() => nativeDrop(['/drop/one', '/drop/two']))
    await vi.waitFor(() => expect(resolveDrop).toHaveBeenCalledOnce())
    const newer = renderDrop()
    await act(async () => gate.resolve())

    expect(stat).toHaveBeenCalledTimes(2)
    expect(older.attach).not.toHaveBeenCalled()
    expect(newer.attach).not.toHaveBeenCalled()
  })

  it('resolves a drop before any project is chosen', async () => {
    const hook = renderDrop(false, {})
    await act(async () => nativeDrop(['/drop/one']))

    expect(resolveDrop).toHaveBeenCalledExactlyOnceWith({ paths: ['/drop/one'] })
    expect(hook.attach.mock.calls[0]?.[0]([])).toEqual(['/drop/one'])
  })

  it('does not revive an old batch when another composer mounts', async () => {
    const gate = Promise.withResolvers<void>()
    holdResolveUntil(gate.promise)
    const older = renderDrop()
    act(() => nativeDrop(['/drop/old-one', '/drop/old-two']))
    await vi.waitFor(() => expect(resolveDrop).toHaveBeenCalledOnce())
    older.unmount()
    const newer = renderDrop()
    await act(async () => {
      nativeDrop(['/drop/new'])
      gate.resolve()
    })

    expect(resolveDrop.mock.calls.map(([input]) => input.paths)).toEqual([
      ['/drop/old-one', '/drop/old-two'],
      ['/drop/new']
    ])
    expect(stat.mock.calls.map(([input]) => input.filePath)).toEqual(['/drop/new'])
    expect(older.attach).not.toHaveBeenCalled()
    expect(newer.attach).toHaveBeenCalledOnce()
  })
})
