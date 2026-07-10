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

export function buildLaunchAgentPlist({ label, programArguments, workingDirectory, logPath, env = {} }) {
  if (!label) throw new Error('label is required')
  if (!Array.isArray(programArguments) || programArguments.length === 0) {
    throw new Error('programArguments must be a non-empty array')
  }
  if (!workingDirectory) throw new Error('workingDirectory is required')
  if (!logPath) throw new Error('logPath is required')

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
${envXml}  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  ${stringEl(logPath)}
  <key>StandardErrorPath</key>
  ${stringEl(logPath)}
</dict>
</plist>
`
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
}) {
  if (!nodePath) throw new Error('nodePath is required')
  if (!bridgeScriptPath) throw new Error('bridgeScriptPath is required')
  if (!configPath) throw new Error('configPath is required')

  const env = {}
  if (pathEnv) env.PATH = pathEnv
  if (home) env.HOME = home

  return buildLaunchAgentPlist({
    label,
    programArguments: [nodePath, bridgeScriptPath, configPath],
    workingDirectory,
    logPath,
    env,
  })
}

export function launchAgentNameFromLabel(label) {
  const normalized = String(label ?? '')
  const parts = normalized.split('.')
  return parts[parts.length - 1] || normalized
}
