import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  toastLoading: vi.fn(() => 'toast-1'),
  toastDismiss: vi.fn(),
  toastError: vi.fn(),
  importExternalPathsToRuntime: vi.fn(),
  resolveDroppedPathsForAgent: vi.fn(),
  recordTerminalUserInputForLeaf: vi.fn(),
  storeState: {
    activeRepoId: 'repo1',
    activeWorktreeId: 'wt-1',
    settings: { activeRuntimeEnvironmentId: 'env-1' as string | null },
    projects: [
      {
        id: 'repo1',
        localWindowsRuntimePreference: { kind: 'inherit-global' as const }
      }
    ] as {
      id: string
      localWindowsRuntimePreference:
        | { kind: 'inherit-global' }
        | { kind: 'windows-host' }
        | { kind: 'wsl'; distro: string | null }
    }[],
    repos: [
      {
        id: 'repo1',
        connectionId: null as string | null,
        path: '/remote/repo',
        executionHostId: 'runtime:env-1' as string | null
      }
    ],
    worktreesByRepo: {
      repo1: [{ id: 'wt-1', repoId: 'repo1', path: '/remote/repo' }]
    },
    sshConnectionStates: new Map<
      string,
      { remotePlatform?: NodeJS.Platform; connectionGeneration?: number }
    >()
  }
}))

vi.mock('sonner', () => ({
  toast: {
    loading: mocks.toastLoading,
    dismiss: mocks.toastDismiss,
    error: mocks.toastError,
    message: vi.fn()
  }
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => mocks.storeState
  }
}))

vi.mock('@/runtime/runtime-file-client', () => ({
  importExternalPathsToRuntime: mocks.importExternalPathsToRuntime
}))

vi.mock('@/lib/new-workspace', () => ({
  CLIENT_PLATFORM: 'win32'
}))

vi.mock('./terminal-input-activity', () => ({
  recordTerminalUserInputForLeaf: mocks.recordTerminalUserInputForLeaf
}))

import { handleTerminalFileDrop } from './terminal-drop-handler'
import { wrapTerminalBracketedPasteText } from './terminal-bracketed-paste'

function createTerminalTransport(
  sendInput: ReturnType<typeof vi.fn>,
  ptyId = 'pty-1',
  sendInputAccepted?: ReturnType<typeof vi.fn>
) {
  return {
    sendInput,
    ...(sendInputAccepted ? { sendInputAccepted } : {}),
    getPtyId: vi.fn(() => ptyId),
    isConnected: vi.fn(() => true)
  }
}

describe('local terminal drop resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Why: main passes ordinary paths through unchanged; tests that need a copy override this.
    mocks.resolveDroppedPathsForAgent
      .mockReset()
      .mockImplementation(async ({ paths }: { paths: string[] }) => ({
        resolvedPaths: paths,
        skipped: [],
        failed: []
      }))
    mocks.storeState.activeRepoId = 'repo1'
    mocks.storeState.activeWorktreeId = 'wt-1'
    vi.stubGlobal('window', {
      api: {
        fs: {
          resolveDroppedPathsForAgent: mocks.resolveDroppedPathsForAgent
        }
      }
    })
    mocks.storeState.settings = { activeRuntimeEnvironmentId: 'env-1' }
    mocks.storeState.projects = [
      {
        id: 'repo1',
        localWindowsRuntimePreference: { kind: 'inherit-global' }
      }
    ]
    mocks.storeState.repos = [
      { id: 'repo1', connectionId: null, path: '/remote/repo', executionHostId: 'runtime:env-1' }
    ]
    mocks.storeState.worktreesByRepo = {
      repo1: [{ id: 'wt-1', repoId: 'repo1', path: '/remote/repo' }]
    }
    mocks.storeState.sshConnectionStates = new Map()
  })

  it('pastes the copy main returns for a drag-temp file, never the original', async () => {
    mocks.storeState.repos = [
      { id: 'repo1', connectionId: null, path: '/repo', executionHostId: 'local' }
    ]
    mocks.storeState.worktreesByRepo = { repo1: [{ id: 'wt-1', repoId: 'repo1', path: '/repo' }] }
    // Why: a name without spaces is pasted raw, so escaping rules can't blur which path won.
    const original = '/var/folders/x/T/TemporaryItems/NSIRD_screencaptureui_1/shot.png'
    const copy = '/var/folders/x/T/orca-drops-501/orca-drop-abc123/shot.png'
    mocks.resolveDroppedPathsForAgent.mockResolvedValue({
      resolvedPaths: [copy],
      skipped: [],
      failed: []
    })
    const sendInput = vi.fn(() => true)
    const pane = { id: 1, leafId: 'leaf-1', terminal: { focus: vi.fn() } }

    await handleTerminalFileDrop({
      manager: { getActivePane: () => pane, getPanes: () => [pane] } as never,
      paneTransports: new Map([[1, createTerminalTransport(sendInput)]]) as never,
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      cwd: undefined,
      data: { paths: [original], target: 'terminal' }
    })

    expect(sendInput).toHaveBeenCalledExactlyOnceWith(
      wrapTerminalBracketedPasteText(copy),
      'driving'
    )
  })

  it('reports a failed local preparation without pasting the original path', async () => {
    mocks.storeState.repos = [
      { id: 'repo1', connectionId: null, path: '/repo', executionHostId: 'local' }
    ]
    mocks.storeState.worktreesByRepo = { repo1: [{ id: 'wt-1', repoId: 'repo1', path: '/repo' }] }
    const original = '/var/folders/x/T/TemporaryItems/NSIRD_screencaptureui_1/shot.png'
    mocks.resolveDroppedPathsForAgent.mockResolvedValue({
      resolvedPaths: [],
      skipped: [],
      failed: [{ sourcePath: original, reason: 'EIO: i/o error' }]
    })
    const sendInput = vi.fn(() => true)
    const pane = { id: 1, leafId: 'leaf-1', terminal: { focus: vi.fn() } }

    await handleTerminalFileDrop({
      manager: { getActivePane: () => pane, getPanes: () => [pane] } as never,
      paneTransports: new Map([[1, createTerminalTransport(sendInput)]]) as never,
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      cwd: undefined,
      data: { paths: [original], target: 'terminal' }
    })

    expect(sendInput).not.toHaveBeenCalled()
    expect(mocks.toastError).toHaveBeenCalledWith('Could not prepare 1 dropped file.', {
      description: 'EIO: i/o error'
    })
  })

  it('does not paste into a replacement PTY when the target changed during local resolution', async () => {
    mocks.storeState.repos = [
      { id: 'repo1', connectionId: null, path: '/repo', executionHostId: 'local' }
    ]
    mocks.storeState.worktreesByRepo = { repo1: [{ id: 'wt-1', repoId: 'repo1', path: '/repo' }] }
    let ptyId = 'pty-1'
    mocks.resolveDroppedPathsForAgent.mockImplementation(async ({ paths }) => {
      ptyId = 'pty-2'
      return { resolvedPaths: paths, skipped: [], failed: [] }
    })
    const sendInput = vi.fn(() => true)
    const focus = vi.fn()
    const pane = { id: 1, leafId: 'leaf-1', terminal: { focus } }
    const transport = createTerminalTransport(sendInput)
    transport.getPtyId.mockImplementation(() => ptyId)

    await handleTerminalFileDrop({
      manager: { getActivePane: () => pane, getPanes: () => [pane] } as never,
      paneTransports: new Map([[1, transport]]) as never,
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      cwd: undefined,
      data: { paths: ['/Users/me/spec.pdf'], target: 'terminal' }
    })

    expect(sendInput).not.toHaveBeenCalled()
    expect(focus).not.toHaveBeenCalled()
    expect(mocks.recordTerminalUserInputForLeaf).not.toHaveBeenCalled()
  })
})
