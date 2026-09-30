// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { AntigravityAccountsSection } from './AntigravityAccountsSection'

vi.mock('@/lib/agent-catalog', () => ({ AgentIcon: () => <span /> }))
vi.mock('../../store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ settingsSearchQuery: '', refreshRateLimits: vi.fn() })
}))
afterEach(cleanup)

it.each([false, true])('lets users change the Gemini opt-in from %s', (enabled) => {
  const updateSettings = vi.fn()
  render(
    <AntigravityAccountsSection
      model={{
        settings: { ...getDefaultSettings('/tmp'), geminiCliOAuthEnabled: enabled },
        updateSettings,
        recordFeatureInteraction: vi.fn(),
        localAccountRuntimeSentenceLabel: 'this device',
        searchQuery: ''
      }}
    />
  )
  if (!enabled) {
    fireEvent.click(screen.getByText('Use Gemini CLI credentials'))
  }
  fireEvent.click(screen.getByRole('switch', { name: 'Use Gemini CLI credentials (experimental)' }))
  expect(updateSettings).toHaveBeenCalledWith({ geminiCliOAuthEnabled: !enabled })
})
