function xmlEscape(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function stringEl(s) {
  return `<string>${xmlEscape(s)}</string>`
}

function checkCommonFields({ label, programArguments, workingDirectory, logPath }) {
  if (!label) throw new Error('label is required')
  if (!Array.isArray(programArguments) || programArguments.length === 0) {
    throw new Error('programArguments must be a non-empty array')
  }
  if (!workingDirectory) throw new Error('workingDirectory is required')
  if (!logPath) throw new Error('logPath is required')
}

// Shared by every plist flavor below; `schedulingXml` is the flavor-specific stanza (RunAtLoad/KeepAlive vs StartCalendarInterval).
function renderPlist({ label, programArguments, workingDirectory, logPath, env, schedulingXml }) {
  const argsXml = programArguments.map(a => `    ${stringEl(a)}`).join('\n')
  const envEntries = Object.entries(env ?? {})
  const envXml = envEntries.length
    ? `  <key>EnvironmentVariables</key>\n  <dict>\n${envEntries
        .map(([k, v]) => `    <key>${xmlEscape(k)}</key>\n    ${stringEl(v)}`)
        .join('\n')}\n  </dict>\n`
    : ''

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  ${stringEl(label)}
  <key>ProgramArguments</key>
  <array>
${argsXml}
  </array>
  <key>WorkingDirectory</key>
  ${stringEl(workingDirectory)}
${envXml}${schedulingXml}  <key>StandardOutPath</key>
  ${stringEl(logPath)}
  <key>StandardErrorPath</key>
  ${stringEl(logPath)}
</dict>
</plist>
`
}

export function buildLaunchAgentPlist({ label, programArguments, workingDirectory, logPath, env = {} }) {
  checkCommonFields({ label, programArguments, workingDirectory, logPath })
  // Without this, a fast crash loop restarts as fast as launchd allows, hammering the Telegram API.
  const schedulingXml =
    '  <key>RunAtLoad</key>\n  <true/>\n  <key>KeepAlive</key>\n  <true/>\n  <key>ThrottleInterval</key>\n  <integer>10</integer>\n'
  return renderPlist({ label, programArguments, workingDirectory, logPath, env, schedulingXml })
}

export function buildBridgeLaunchAgentPlist({
  label,
  nodePath,
  bridgeScriptPath,
  configPath,
  workingDirectory,
  logPath,
  pathEnv,
  home,
  apiKey,
}) {
  if (!nodePath) throw new Error('nodePath is required')
  if (!bridgeScriptPath) throw new Error('bridgeScriptPath is required')
  if (!configPath) throw new Error('configPath is required')

  const env = {}
  if (pathEnv) env.PATH = pathEnv
  if (home) env.HOME = home
  // launchd doesn't source ~/.zshrc, so without this `claude` falls back to subscription login.
  if (apiKey) env.ANTHROPIC_API_KEY = apiKey

  return buildLaunchAgentPlist({
    label,
    programArguments: [nodePath, bridgeScriptPath, configPath],
    workingDirectory,
    logPath,
    env,
  })
}

// For a once-a-day job (StartCalendarInterval) — no KeepAlive/RunAtLoad, unlike the always-on bridge process.
export function buildCalendarLaunchAgentPlist({ label, programArguments, workingDirectory, logPath, hour, minute, env = {} }) {
  checkCommonFields({ label, programArguments, workingDirectory, logPath })
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) throw new Error('hour must be an integer 0-23')
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) throw new Error('minute must be an integer 0-59')

  const schedulingXml = `  <key>StartCalendarInterval</key>\n  <dict>\n    <key>Hour</key>\n    <integer>${hour}</integer>\n    <key>Minute</key>\n    <integer>${minute}</integer>\n  </dict>\n`
  return renderPlist({ label, programArguments, workingDirectory, logPath, env, schedulingXml })
}

export function launchAgentNameFromLabel(label) {
  const normalized = String(label ?? '')
  const parts = normalized.split('.')
  return parts[parts.length - 1] || normalized
}
