import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { describeDropSkipReason } from '@/lib/drop-skip-reason-copy'
import { compactIpcErrorMessage } from '@/lib/ipc-error'

/** `upload` moved bytes to another host; `prepare` resolved paths on this machine. */
export type TerminalDropOperation = 'upload' | 'prepare'

export function reportTerminalDropUploadSkipsAndFailures(
  skipped: { reason: string }[],
  failed: { reason: string }[],
  operation: TerminalDropOperation = 'upload'
): void {
  if (skipped.length > 0) {
    // Why: symlink rejection is policy, not an error; mixed reasons stay generic.
    const allSymlinks = skipped.every((item) => item.reason === 'symlink')
    const noun = skipped.length === 1 ? 'item' : 'items'
    const commonReason = sharedReason(skipped)
    toast.message(
      allSymlinks
        ? translate(
            'auto.components.terminal.pane.terminal.drop.handler.53f015fd85',
            'Skipped {{value0}} symlink{{value1}}.',
            { value0: skipped.length, value1: skipped.length === 1 ? '' : 's' }
          )
        : translate(
            'auto.components.terminal.pane.terminal.drop.handler.b4cf68e889',
            'Skipped {{value0}} {{value1}}.',
            { value0: skipped.length, value1: noun }
          ),
      {
        description:
          commonReason && commonReason !== 'symlink'
            ? describeDropSkipReason(commonReason)
            : undefined
      }
    )
  }
  if (failed.length > 0) {
    const noun = failed.length === 1 ? 'file' : 'files'
    if (operation === 'upload') {
      toast.error(
        translate(
          'auto.components.terminal.pane.terminal.drop.handler.1e072f611e',
          'Failed to upload {{value0}} {{value1}}.',
          { value0: failed.length, value1: noun }
        )
      )
      return
    }
    // Why: local resolution mints reasons without paths, so a shared one is safe to show.
    const commonReason = sharedReason(failed)
    toast.error(
      translate(
        'auto.components.terminal.pane.terminal.drop.handler.prepareFailed',
        'Could not prepare {{value0}} dropped {{value1}}.',
        { value0: failed.length, value1: noun }
      ),
      { description: commonReason ? compactIpcErrorMessage(commonReason) : undefined }
    )
  }
}

function sharedReason(items: { reason: string }[]): string | undefined {
  const first = items[0]?.reason
  return first !== undefined && items.every((item) => item.reason === first) ? first : undefined
}
