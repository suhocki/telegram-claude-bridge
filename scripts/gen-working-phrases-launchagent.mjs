#!/usr/bin/env node
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildCalendarLaunchAgentPlist } from '../launchagent.mjs'

const LABEL = 'com.tgbridge.working-phrases'
const [outputArg] = process.argv.slice(2)

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const scriptPath = path.join(repoRoot, 'scripts', 'update-working-phrases.mjs')
const home = process.env.HOME
if (!home) {
  console.error('HOME is not set in the environment')
  process.exit(1)
}
const logPath = path.join(home, 'Library', 'Logs', 'telegram-bridge-working-phrases.log')

const plist = buildCalendarLaunchAgentPlist({
  label: LABEL,
  programArguments: [process.execPath, scriptPath],
  workingDirectory: repoRoot,
  logPath,
  hour: 6,
  minute: 0,
  env: { PATH: process.env.PATH, HOME: home },
})

if (outputArg) {
  writeFileSync(outputArg, plist)
  console.error(`wrote ${outputArg}`)
  console.error(`install with:\n  cp ${outputArg} ~/Library/LaunchAgents/${LABEL}.plist\n  launchctl bootstrap gui/$UID ~/Library/LaunchAgents/${LABEL}.plist`)
  console.error(`run once by hand to check it works:\n  launchctl kickstart -k gui/$UID/${LABEL}`)
} else {
  process.stdout.write(plist)
}
