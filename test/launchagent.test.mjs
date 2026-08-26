import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildLaunchAgentPlist,
  buildBridgeLaunchAgentPlist,
  buildCalendarLaunchAgentPlist,
  launchAgentNameFromLabel,
} from '../launchagent.mjs'

test('buildLaunchAgentPlist: throws when a required field is missing', () => {
  assert.throws(() => buildLaunchAgentPlist({ programArguments: ['a'], workingDirectory: '/x', logPath: '/l' }), /label/)
  assert.throws(() => buildLaunchAgentPlist({ label: 'l', workingDirectory: '/x', logPath: '/l' }), /programArguments/)
  assert.throws(() => buildLaunchAgentPlist({ label: 'l', programArguments: [], workingDirectory: '/x', logPath: '/l' }), /programArguments/)
  assert.throws(() => buildLaunchAgentPlist({ label: 'l', programArguments: ['a'], logPath: '/l' }), /workingDirectory/)
  assert.throws(() => buildLaunchAgentPlist({ label: 'l', programArguments: ['a'], workingDirectory: '/x' }), /logPath/)
})

test('buildLaunchAgentPlist: emits Label, ProgramArguments, WorkingDirectory, RunAtLoad and KeepAlive', () => {
  const xml = buildLaunchAgentPlist({
    label: 'com.tgbridge.tldr',
    programArguments: ['/usr/bin/node', '/repo/bridge.mjs', '/repo/tldr.config.json'],
    workingDirectory: '/repo',
    logPath: '/logs/telegram-bridge-tldr.log',
  })

  assert.match(xml, /<key>Label<\/key>\s*<string>com\.tgbridge\.tldr<\/string>/)
  assert.match(xml, /<key>ProgramArguments<\/key>\s*<array>/)
  assert.match(xml, /<string>\/usr\/bin\/node<\/string>/)
  assert.match(xml, /<string>\/repo\/bridge\.mjs<\/string>/)
  assert.match(xml, /<string>\/repo\/tldr\.config\.json<\/string>/)
  assert.match(xml, /<key>WorkingDirectory<\/key>\s*<string>\/repo<\/string>/)
  assert.match(xml, /<key>RunAtLoad<\/key>\s*<true\/>/)
  assert.match(xml, /<key>KeepAlive<\/key>\s*<true\/>/)
})

test('buildLaunchAgentPlist: emits a ThrottleInterval so a fast crash loop cannot hammer the Telegram API', () => {
  const xml = buildLaunchAgentPlist({
    label: 'com.tgbridge.tldr',
    programArguments: ['/usr/bin/node'],
    workingDirectory: '/repo',
    logPath: '/logs/telegram-bridge-tldr.log',
  })
  assert.match(xml, /<key>ThrottleInterval<\/key>\s*<integer>\d+<\/integer>/)
})

test('buildLaunchAgentPlist: StandardOutPath and StandardErrorPath both point at the same log file', () => {
  const xml = buildLaunchAgentPlist({
    label: 'com.tgbridge.tldr',
    programArguments: ['/usr/bin/node'],
    workingDirectory: '/repo',
    logPath: '/logs/telegram-bridge-tldr.log',
  })

  assert.match(xml, /<key>StandardOutPath<\/key>\s*<string>\/logs\/telegram-bridge-tldr\.log<\/string>/)
  assert.match(xml, /<key>StandardErrorPath<\/key>\s*<string>\/logs\/telegram-bridge-tldr\.log<\/string>/)
})

test('buildLaunchAgentPlist: env explicitly passed as null is treated the same as omitted', () => {
  const xml = buildLaunchAgentPlist({
    label: 'com.tgbridge.tldr',
    programArguments: ['/usr/bin/node'],
    workingDirectory: '/repo',
    logPath: '/logs/telegram-bridge-tldr.log',
    env: null,
  })
  assert.doesNotMatch(xml, /EnvironmentVariables/)
})

test('buildLaunchAgentPlist: omits EnvironmentVariables when env is not given', () => {
  const xml = buildLaunchAgentPlist({
    label: 'com.tgbridge.tldr',
    programArguments: ['/usr/bin/node'],
    workingDirectory: '/repo',
    logPath: '/logs/telegram-bridge-tldr.log',
  })
  assert.doesNotMatch(xml, /EnvironmentVariables/)
})

test('buildLaunchAgentPlist: includes EnvironmentVariables entries when env is given', () => {
  const xml = buildLaunchAgentPlist({
    label: 'com.tgbridge.tldr',
    programArguments: ['/usr/bin/node'],
    workingDirectory: '/repo',
    logPath: '/logs/telegram-bridge-tldr.log',
    env: { PATH: '/opt/homebrew/bin:/usr/bin', HOME: '/Users/foo' },
  })
  assert.match(xml, /<key>EnvironmentVariables<\/key>\s*<dict>/)
  assert.match(xml, /<key>PATH<\/key>\s*<string>\/opt\/homebrew\/bin:\/usr\/bin<\/string>/)
  assert.match(xml, /<key>HOME<\/key>\s*<string>\/Users\/foo<\/string>/)
})

test('buildLaunchAgentPlist: escapes XML-special characters in string values', () => {
  const xml = buildLaunchAgentPlist({
    label: 'com.tgbridge.tldr',
    programArguments: ['/usr/bin/node', '/repo/config <staging>&"prod".json'],
    workingDirectory: '/repo',
    logPath: '/logs/telegram-bridge-tldr.log',
  })
  assert.match(xml, /<string>\/repo\/config &lt;staging&gt;&amp;&quot;prod&quot;\.json<\/string>/)
  assert.doesNotMatch(xml, /<staging>/)
})

test('buildLaunchAgentPlist: produces well-formed, parseable XML', () => {
  const xml = buildLaunchAgentPlist({
    label: 'com.tgbridge.tldr',
    programArguments: ['/usr/bin/node', '/repo/bridge.mjs'],
    workingDirectory: '/repo',
    logPath: '/logs/telegram-bridge-tldr.log',
    env: { PATH: '/usr/bin', HOME: '/Users/foo' },
  })
  assert.equal((xml.match(/<dict>/g) || []).length, (xml.match(/<\/dict>/g) || []).length)
  assert.equal((xml.match(/<array>/g) || []).length, (xml.match(/<\/array>/g) || []).length)
  assert.equal((xml.match(/<string>/g) || []).length, (xml.match(/<\/string>/g) || []).length)
})

test('buildBridgeLaunchAgentPlist: throws when nodePath, bridgeScriptPath or configPath is missing', () => {
  assert.throws(() => buildBridgeLaunchAgentPlist({ bridgeScriptPath: '/b', configPath: '/c', workingDirectory: '/w', logPath: '/l' }), /nodePath/)
  assert.throws(() => buildBridgeLaunchAgentPlist({ nodePath: '/n', configPath: '/c', workingDirectory: '/w', logPath: '/l' }), /bridgeScriptPath/)
  assert.throws(() => buildBridgeLaunchAgentPlist({ nodePath: '/n', bridgeScriptPath: '/b', workingDirectory: '/w', logPath: '/l' }), /configPath/)
})

test('buildBridgeLaunchAgentPlist: wires ProgramArguments to [node, bridge.mjs, config.json] in order', () => {
  const xml = buildBridgeLaunchAgentPlist({
    label: 'com.tgbridge.tldr',
    nodePath: '/opt/homebrew/bin/node',
    bridgeScriptPath: '/repo/bridge.mjs',
    configPath: '/repo/tldr.config.json',
    workingDirectory: '/repo',
    logPath: '/logs/telegram-bridge-tldr.log',
  })
  const order = ['/opt/homebrew/bin/node', '/repo/bridge.mjs', '/repo/tldr.config.json'].map(s =>
    xml.indexOf(`<string>${s}</string>`),
  )
  assert.ok(order.every(i => i >= 0))
  assert.ok(order[0] < order[1] && order[1] < order[2])
})

test('buildBridgeLaunchAgentPlist: includes PATH/HOME env only when provided', () => {
  const withEnv = buildBridgeLaunchAgentPlist({
    label: 'com.tgbridge.tldr',
    nodePath: '/n',
    bridgeScriptPath: '/b',
    configPath: '/c',
    workingDirectory: '/repo',
    logPath: '/l',
    pathEnv: '/usr/bin',
    home: '/Users/foo',
  })
  assert.match(withEnv, /EnvironmentVariables/)

  const withoutEnv = buildBridgeLaunchAgentPlist({
    label: 'com.tgbridge.tldr',
    nodePath: '/n',
    bridgeScriptPath: '/b',
    configPath: '/c',
    workingDirectory: '/repo',
    logPath: '/l',
  })
  assert.doesNotMatch(withoutEnv, /EnvironmentVariables/)
})

test('buildBridgeLaunchAgentPlist: includes ANTHROPIC_API_KEY only when apiKey is provided', () => {
  const withKey = buildBridgeLaunchAgentPlist({
    label: 'com.tgbridge.tldr',
    nodePath: '/n',
    bridgeScriptPath: '/b',
    configPath: '/c',
    workingDirectory: '/repo',
    logPath: '/l',
    apiKey: 'sk-ant-api03-secret',
  })
  assert.match(withKey, /<key>ANTHROPIC_API_KEY<\/key>\s*<string>sk-ant-api03-secret<\/string>/)

  const withoutKey = buildBridgeLaunchAgentPlist({
    label: 'com.tgbridge.tldr',
    nodePath: '/n',
    bridgeScriptPath: '/b',
    configPath: '/c',
    workingDirectory: '/repo',
    logPath: '/l',
  })
  assert.doesNotMatch(withoutKey, /ANTHROPIC_API_KEY/)
})

test('buildCalendarLaunchAgentPlist: throws when a required field is missing or hour/minute are out of range', () => {
  const base = { label: 'l', programArguments: ['/n'], workingDirectory: '/w', logPath: '/l', hour: 6, minute: 0 }
  assert.throws(() => buildCalendarLaunchAgentPlist({ ...base, label: undefined }), /label/)
  assert.throws(() => buildCalendarLaunchAgentPlist({ ...base, programArguments: [] }), /programArguments/)
  assert.throws(() => buildCalendarLaunchAgentPlist({ ...base, workingDirectory: undefined }), /workingDirectory/)
  assert.throws(() => buildCalendarLaunchAgentPlist({ ...base, logPath: undefined }), /logPath/)
  assert.throws(() => buildCalendarLaunchAgentPlist({ ...base, hour: 24 }), /hour/)
  assert.throws(() => buildCalendarLaunchAgentPlist({ ...base, hour: -1 }), /hour/)
  assert.throws(() => buildCalendarLaunchAgentPlist({ ...base, minute: 60 }), /minute/)
  assert.throws(() => buildCalendarLaunchAgentPlist({ ...base, minute: 1.5 }), /minute/)
})

test('buildCalendarLaunchAgentPlist: emits StartCalendarInterval instead of RunAtLoad/KeepAlive', () => {
  const xml = buildCalendarLaunchAgentPlist({
    label: 'com.tgbridge.working-phrases',
    programArguments: ['/usr/bin/node', '/repo/scripts/update-working-phrases.mjs'],
    workingDirectory: '/repo',
    logPath: '/logs/telegram-bridge-working-phrases.log',
    hour: 6,
    minute: 30,
  })
  assert.match(xml, /<key>StartCalendarInterval<\/key>\s*<dict>\s*<key>Hour<\/key>\s*<integer>6<\/integer>\s*<key>Minute<\/key>\s*<integer>30<\/integer>/)
  assert.doesNotMatch(xml, /<key>RunAtLoad<\/key>/)
  assert.doesNotMatch(xml, /<key>KeepAlive<\/key>/)
  assert.equal((xml.match(/<dict>/g) || []).length, (xml.match(/<\/dict>/g) || []).length)
})

test('launchAgentNameFromLabel: takes the last dot-separated segment', () => {
  assert.equal(launchAgentNameFromLabel('com.tgbridge.tldr'), 'tldr')
  assert.equal(launchAgentNameFromLabel('com.tgbridge.ig'), 'ig')
})

test('launchAgentNameFromLabel: falls back to the input when there is no dot', () => {
  assert.equal(launchAgentNameFromLabel('tldr'), 'tldr')
})

test('launchAgentNameFromLabel: null/undefined/empty become an empty string', () => {
  assert.equal(launchAgentNameFromLabel(null), '')
  assert.equal(launchAgentNameFromLabel(undefined), '')
  assert.equal(launchAgentNameFromLabel(''), '')
})
