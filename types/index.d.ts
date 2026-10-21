/**
 * A tracked file: its content at the baseline (Clear) and as Claude's last tool
 * call left it; null = absent. `isMixed` when an outside edit could not be
 * separated from Claude's.
 */
export type Entry = { baseline: string | null; current: string | null; isMixed?: boolean }

declare module 'claude-code' {
  interface PluginState {
    'change-monitor': {
      entries: Record<string, Entry>
      collapsed: Record<string, boolean>
      root: string
      status: 'on' | 'off'
    }
  }
}
