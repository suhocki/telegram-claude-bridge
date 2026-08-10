#!/usr/bin/env node
import { writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildBridgeLaunchAgentPlist, launchAgentNameFromLabel } from '../launchagent.mjs'

const [label, configArg, outputArg] = process.argv.slice(2)
if (!label || !configArg) {
  console.error('usage: node scripts/gen-launchagent.mjs <label, e.g. com.tgbridge.tldr> <config.json> [output.plist]')
  process.exit(1)
}

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const bridgeScriptPath = path.join(repoRoot, 'bridge.mjs')
const configPath = path.resolve(process.cwd(), configArg)
if (!existsSync(configPath)) {
  console.error(`config not found: ${configPath} (the generated agent would crash-loop under KeepAlive)`)
  process.exit(1)
}
const home = process.env.HOME
if (!home) {
  console.error('HOME is not set in the environment')
  process.exit(1)
}
if (!process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY is not set in the environment (the generated agent would fall back to the Claude Code subscription login)')
  process.exit(1)
}
const name = launchAgentNameFromLabel(label)
const logPath = path.join(home, 'Library', 'Logs', `telegram-bridge-${name}.log`)

const plist = buildBridgeLaunchAgentPlist({
  label,
  nodePath: process.execPath,
  bridgeScriptPath,
  configPath,
  workingDirectory: repoRoot,
  logPath,
  pathEnv: process.env.PATH,
  home,
  apiKey: process.env.ANTHROPIC_API_KEY,
})

if (outputArg) {
  writeFileSync(outputArg, plist)
  console.error(`wrote ${outputArg}`)
  console.error(`install with:\n  cp ${outputArg} ~/Library/LaunchAgents/${label}.plist\n  launchctl bootstrap gui/$UID ~/Library/LaunchAgents/${label}.plist`)
  console.error(`restart with:\n  launchctl kickstart -k gui/$UID/${label}`)
} else {
  process.stdout.write(plist)
}
