import { useState } from 'react'
import { AgentIcon } from '@/lib/agent-catalog'
import { translate } from '@/i18n/i18n'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import { useAppStore } from '../../store'
import { Button } from '../ui/button'
import { SearchableSetting } from './SearchableSetting'
import { translateSearchKeyword } from './settings-search-keywords'

export const getAccountsAntigravitySearchEntries = createLocalizedCatalog(() => [
  {
    title: translate('settings.accounts.antigravity.title', 'Gemini (Antigravity)'),
    description: translate(
      'settings.accounts.antigravity.description',
      'Sign in through the Antigravity CLI to view your usage in Orca.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.accounts.search.e8e1ff3887', 'gemini'),
      ...translateSearchKeyword('auto.components.settings.appearance.search.51b0ccd6a2', 'google'),
      ...translateSearchKeyword(
        'auto.components.settings.appearance.search.antigravityKeyword',
        'antigravity'
      ),
      ...translateSearchKeyword('settings.accounts.antigravity.command', 'agy'),
      ...translateSearchKeyword('auto.components.settings.accounts.search.8630464352', 'cli'),
      ...translateSearchKeyword('auto.components.settings.accounts.search.a9f3d7b5c8', 'login'),
      ...translateSearchKeyword('auto.components.settings.accounts.search.c759741d77', 'quota'),
      ...translateSearchKeyword('auto.components.settings.appearance.search.00a028f25f', 'usage'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.f66a7cf715', 'terminal')
    ]
  }
])

export function AntigravityAccountsSection(): React.JSX.Element {
  const refreshRateLimits = useAppStore((state) => state.refreshRateLimits)
  const [refreshing, setRefreshing] = useState(false)
  const [entry] = getAccountsAntigravitySearchEntries()

  async function refreshUsage(): Promise<void> {
    setRefreshing(true)
    try {
      await refreshRateLimits()
    } finally {
      setRefreshing(false)
    }
  }

  return (
    <section id="accounts-gemini" className="space-y-4 scroll-mt-6">
      <div className="space-y-1">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <AgentIcon agent="antigravity" size={16} />
          {entry.title}
        </h3>
        <p className="text-xs text-muted-foreground">{entry.description}</p>
      </div>
      <SearchableSetting {...entry} className="space-y-3">
        <p className="text-xs text-muted-foreground">
          {translate(
            'settings.accounts.antigravity.signIn',
            'With Antigravity CLI installed, run this command in a terminal on the computer running Orca. Complete Google sign-in in the browser if prompted, then return here and refresh usage.'
          )}
        </p>
        <pre className="rounded-md border bg-muted p-3 text-xs">
          <code>{translate('settings.accounts.antigravity.command', 'agy')}</code>
        </pre>
        <p className="text-xs text-muted-foreground">
          {translate(
            'settings.accounts.antigravity.usage',
            'Orca uses that CLI session to read your quota. To show it in the status bar, enable Antigravity Usage in Appearance → Status Bar.'
          )}
        </p>
        <Button variant="outline" size="sm" disabled={refreshing} onClick={refreshUsage}>
          {refreshing
            ? translate('settings.accounts.antigravity.refreshing', 'Refreshing usage…')
            : translate('settings.accounts.antigravity.refresh', 'Refresh usage')}
        </Button>
      </SearchableSetting>
    </section>
  )
}
