import { parseWslPath, toLinuxPath } from '../wsl'
import {
  materializeDragTempPaths,
  type DragTempCopyEnvironment,
  type LocalDropItemResult
} from './dragged-temp-file-copy'
import { authorizeExternalPath } from './filesystem-auth'

/**
 * Turn locally dropped paths into paths the agent can read, one result per
 * input in drop order. Drag-temp files are copied; everything else passes through.
 */
export async function resolveLocalDroppedPathsForAgent(
  paths: string[],
  worktreePath: string | undefined,
  env: DragTempCopyEnvironment,
  signal?: AbortSignal
): Promise<LocalDropItemResult[]> {
  const results = await materializeDragTempPaths(paths, env, signal)
  // Why: a local WSL PTY runs inside Linux, so Windows drop paths must be
  // rewritten to paths the shell and agent can read.
  const targetWsl = worktreePath ? parseWslPath(worktreePath) : null
  return results.map((result) => {
    if (result.status !== 'imported') {
      return result
    }
    // Why: an OS drop authorizes what it hands over, so Orca's own preview
    // and read APIs accept it without a per-path renderer round trip.
    authorizeExternalPath(result.destPath)
    return targetWsl
      ? {
          ...result,
          destPath: resolveDroppedPathForTargetWsl(result.destPath, targetWsl.distro)
        }
      : result
  })
}

function resolveDroppedPathForTargetWsl(droppedPath: string, targetDistro: string): string {
  const droppedWsl = parseWslPath(droppedPath)
  if (droppedWsl) {
    // Why: WSL UNC paths are only Linux-native inside their own distro.
    // Rewriting another distro would paste a plausible but wrong path.
    return isSameWslDistro(droppedWsl.distro, targetDistro) ? droppedWsl.linuxPath : droppedPath
  }
  return toLinuxPath(droppedPath)
}

function isSameWslDistro(left: string, right: string): boolean {
  return left.localeCompare(right, undefined, { sensitivity: 'accent' }) === 0
}
