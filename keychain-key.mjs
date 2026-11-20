import { execFileSync } from 'node:child_process'

export const DEFAULT_KEYCHAIN_SERVICE = 'anthropic-api-key'

function defaultRead(service) {
  return execFileSync('/usr/bin/security', ['find-generic-password', '-s', service, '-w'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  })
}

// The key lives in the macOS Keychain, not in the launchd plist. An already-set env var wins,
// so a manual `ANTHROPIC_API_KEY=... node bridge.mjs` still works. Returns null when there is no item.
export function resolveAnthropicApiKey(env, { read = defaultRead } = {}) {
  if (env.ANTHROPIC_API_KEY) return env.ANTHROPIC_API_KEY
  const service = env.ANTHROPIC_API_KEY_KEYCHAIN_SERVICE || DEFAULT_KEYCHAIN_SERVICE
  try {
    const key = String(read(service)).trim()
    return key || null
  } catch {
    return null
  }
}
