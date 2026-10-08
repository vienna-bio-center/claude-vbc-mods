import type { SessionContextBreakdown } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'

import type { Part } from '../types'
import { addHeavy, bar, kilo, labelOf, limitLabel, segments, stepTokens, tone, toLimits, until } from './register'

const PARTS: Part[] = [
  { name: 'System prompt', tokens: 4000, color: 'promptBorder', kind: 'used' },
  { name: 'Messages', tokens: 36000, color: 'permission', kind: 'used' },
  { name: 'MCP tools', tokens: 8000, color: 'success', kind: 'deferred' },
  { name: 'Free space', tokens: 140000, color: 'inactive', kind: 'free' },
  { name: 'Autocompact buffer', tokens: 20000, color: 'inactive', kind: 'buffer' },
]

const BREAKDOWN = {
  categories: PARTS.map(p => ({ ...p, isDeferred: p.kind === 'deferred' })),
  totalTokens: 40000,
  maxTokens: 200000,
  rawMaxTokens: 200000,
  autocompactSource: 'auto',
  percentage: 20,
  gridRows: [],
  model: 'claude-opus-5-5',
  memoryFiles: [{ path: '/Users/x/.claude/CLAUDE.md', type: 'User', tokens: 900 }],
  mcpTools: [
    { name: 'mcp__agentgateway__a', serverName: 'agentgateway', tokens: 4000, isLoaded: true },
    { name: 'mcp__agentgateway__b', serverName: 'agentgateway', tokens: 2000, isLoaded: true },
    { name: 'mcp__azure__c', serverName: 'azure', tokens: 9000, isLoaded: false },
  ],
  agents: [{ agentType: 'Explore', source: 'built-in', tokens: 1500 }],
  isAutoCompactEnabled: true,
  autoCompactThreshold: 167000,
  apiUsage: null,
} as unknown as SessionContextBreakdown

describe('helpers', () => {
  test('bar splits width by percent', async () => {
    expect(bar(40, 10).filled.length).toBe(4)
    expect(bar(150, 10).filled.length).toBe(10)
  })

  test('tone follows the statusline thresholds', async () => {
    expect(tone(49)).toBe('success')
    expect(tone(50)).toBe('warning')
    expect(tone(80)).toBe('error')
  })

  test('kilo formats tokens', async () => {
    expect(kilo(840)).toBe('840')
    expect(kilo(2_400)).toBe('2.4k')
    expect(kilo(84_200)).toBe('84k')
    expect(kilo(1_000_000)).toBe('1.0M')
  })

  test('segments cover only used rows and fill the rest', async () => {
    const s = segments(PARTS, 200000, 20)
    expect(s.used.map(x => x.cells)).toEqual([4])
    expect(s.rest).toBe(16)
    expect(s.used.reduce((n, x) => n + x.cells, 0) + s.rest).toBe(20)
  })

  test('addHeavy keeps the 10 largest', async () => {
    let list = [] as ReturnType<typeof addHeavy>
    for (let i = 0; i < 15; i++) list = addHeavy(list, { id: `${i}`, tool: 'Read', label: '', tokens: i })
    expect(list.length).toBe(10)
    expect(list[0]?.tokens).toBe(14)
  })

  test('stepTokens adds up the input side of a response', async () => {
    expect(
      stepTokens({ input_tokens: 500, output_tokens: 9000, cache_read_input_tokens: 70000, cache_creation_input_tokens: 4500 }),
    ).toBe(75000)
  })

  test('until counts down coarsely', async () => {
    expect(until(null, 0)).toBe('')
    expect(until(45 * 60_000, 0)).toBe('45m')
    expect(until(130 * 60_000, 0)).toBe('2h10')
    expect(until(3 * 24 * 3_600_000, 0)).toBe('3d')
    expect(until(0, 60_000)).toBe('0m')
  })

  test('limits get short labels and parsed reset times', async () => {
    expect(limitLabel('five_hour')).toBe('5h')
    expect(limitLabel('seven_day')).toBe('7d')
    expect(limitLabel('spend_limit')).toBe('Budget')
    expect(limitLabel('other_thing')).toBe('other thing')
    expect(toLimits([{ kind: 'five_hour', percentUsed: 42.5, resetsAt: '2026-10-08T12:00:00Z' }])).toEqual([
      { kind: 'five_hour', percent: 42.5, resetsAt: Date.parse('2026-10-08T12:00:00Z') },
    ])
    expect(toLimits([{ kind: 'seven_day', percentUsed: 3, resetsAt: 'nonsense' }])[0]?.resetsAt).toBeNull()
  })

  test('labelOf picks the telling field', async () => {
    expect(labelOf({ file_path: '/a/b.ts', limit: 3 })).toBe('/a/b.ts')
    expect(labelOf({ command: 'ls   -la\n' })).toBe('ls -la')
    expect(labelOf({ other: 1 })).toBe('')
  })
})

const BAND = {
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

const PANE_PROPS = {
  component: 'Pane',
  requestId: 'context-meter',
  props: {
    title: 'Context',
    isFocused: false,
    bodyColumns: 90,
    placement: 'inline',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

test('band and pane show the breakdown on terminal and desktop', async ($, on) => {
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { tokens: 40000, window: 200000, percent: 20, breakdown: BREAKDOWN },
      rateLimits: [],
    },
  }))
  on('env.get', () => ({ value: '/Users/x' }))
  on('command.run', () => ({ text: '' }))
  await $.command.run({ command: 'context-details' } as never)

  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ plugin: 'context-meter', surface, ...BAND })
    expect(await band.find({ type: 'Text', text: /20%/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /Messages 36k/ })).toBeDefined()
    expect(await band.find({ key: 'details' })).toBeDefined()
    await band.unmount()

    const pane = await $.ui.mount({ plugin: 'context-meter', surface, ...PANE_PROPS })
    expect(await pane.find({ type: 'Text', text: /agentgateway/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /2 Tools/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /azure/ })).toBeUndefined()
    expect(await pane.find({ type: 'Text', text: /~\/\.claude\/CLAUDE\.md/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /on demand/ })).toBeDefined()
    await pane.unmount()
  }
})

test('large tool results of the main loop are listed in the pane', async ($, on) => {
  on('session.usage', () => ({
    value: { startedAt: 0, context: { tokens: 40000, window: 200000, percent: 20, breakdown: BREAKDOWN }, rateLimits: [] },
  }))
  on('env.get', () => ({ value: '/Users/x' }))
  on('command.run', () => ({ text: '' }))
  on('tool.call', () => ({ result: { type: 'text' }, text: 'x'.repeat(8000) }) as never)
  // the full tool union is too deep for tsc here; the call itself is checked at run time
  const loose = $ as unknown as { tool: { call: (input: unknown) => Promise<unknown> } }
  await loose.tool.call({ tool: 'Read', file_path: '/tmp/big.log' })
  await $.command.run({ command: 'context-details' } as never)

  const pane = await $.ui.mount({ plugin: 'context-meter', surface: 'terminal', ...PANE_PROPS })
  expect(await pane.find({ type: 'Text', text: /Read: \/tmp\/big\.log/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /^2\.0k$/ })).toBeDefined()
  await pane.unmount()
})

type Node = { type: string; props?: Record<string, unknown>; children?: unknown[] }
const textOf = (n: unknown): string =>
  typeof n === 'string' || typeof n === 'number'
    ? String(n)
    : n && typeof n === 'object'
      ? ((n as Node).children ?? []).map(textOf).join('')
      : ''

test('5h limit on the first row, the week on the second, no cost', async ($, on) => {
  const resetsAt = new Date(Date.now() + 130 * 60_000).toISOString()
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { tokens: 40000, window: 200000, percent: 20, breakdown: BREAKDOWN },
      rateLimits: [
        { kind: 'seven_day', percentUsed: 85.5 },
        { kind: 'five_hour', percentUsed: 42, resetsAt },
      ],
      cost: { usd: 4.125 },
    },
  }))
  on('env.get', () => ({ value: '/Users/x' }))
  on('command.run', () => ({ text: '' }))
  await $.command.run({ command: 'context-details' } as never)

  for (const surface of ['terminal', 'desktop'] as const) {
    const wide = await $.ui.mount({ plugin: 'context-meter', surface, ...BAND, props: { ...BAND.props, bodyColumns: 140 } })
    const rows = ((await wide.drawn()) as Node).children?.filter(Boolean) ?? []
    expect(rows.length).toBe(2)
    expect(textOf(rows[0])).toMatch(/5h █{2}░{3} 42% ↻2h10$/)
    expect(textOf(rows[0])).not.toMatch(/7d/)
    expect(textOf(rows[1])).toMatch(/7d █{4}░ 86%$/)
    expect(textOf(rows[1])).toMatch(/Messages 36k/)
    expect(await wide.find({ type: 'Text', text: /\$|session/i })).toBeUndefined()
    expect(await wide.find({ key: 'details' })).toBeDefined()
    await wide.unmount()

    const narrow = await $.ui.mount({ plugin: 'context-meter', surface, ...BAND, props: { ...BAND.props, bodyColumns: 80 } })
    const nrows = ((await narrow.drawn()) as Node).children?.filter(Boolean) ?? []
    expect(textOf(nrows[0])).toMatch(/5h 42%$/)
    expect(textOf(nrows[1])).toMatch(/7d 86%$/)
    await narrow.unmount()
  }
})
