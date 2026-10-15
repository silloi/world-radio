export type Station = { name: string; countrycode: string; url: string; lng?: number }
export type RadioStatus = 'stopped' | 'loading' | 'tuning' | 'playing' | 'error'

declare module 'claude-code' {
  interface PluginState {
    'world-radio': { station: Station | null; status: RadioStatus; title: string | null }
  }
}
