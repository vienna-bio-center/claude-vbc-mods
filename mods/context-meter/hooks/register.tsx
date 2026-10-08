import { atom, read, update } from 'claude-code'
import type {
  EngineInterface,
  ModelUsage,
  Register,
  SessionContextBreakdown,
  SessionContextUsage,
} from 'claude-code'

import type { Details, Fill, Heavy, Item, Limit, Part } from '../types'

const PANE = 'context-meter'
const fill = atom({ plugin: 'context-meter', key: 'fill' } as const, null)
const details = atom({ plugin: 'context-meter', key: 'details' } as const, null)
const heavy = atom({ plugin: 'context-meter', key: 'heavy' } as const, [])
const limits = atom({ plugin: 'context-meter', key: 'limits' } as const, [])
const now = atom({ plugin: 'context-meter', key: 'now' } as const, 0)

const toFill = (c: SessionContextUsage): Fill => ({
  tokens: c.tokens ?? null,
  window: c.window,
  percent: c.percent ?? null,
})

export const kilo = (n: number) =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(1)}M`
    : n >= 10_000
      ? `${Math.round(n / 1000)}k`
      : n >= 1000
        ? `${(n / 1000).toFixed(1)}k`
        : `${n}`

export const bar = (percent: number, width: number) => {
  const filled = Math.round((Math.min(100, Math.max(0, percent)) / 100) * width)
  return { filled: '█'.repeat(filled), empty: '░'.repeat(width - filled) }
}

export const tone = (percent: number) =>
  percent >= 80 ? 'error' : percent >= 50 ? 'warning' : 'success'

/** Splits `width` cells over the used rows in order, cumulative rounding so nothing gaps. */
export const segments = (parts: Part[], max: number, width: number) => {
  const out: { color: string; cells: number }[] = []
  let sum = 0
  let drawn = 0
  for (const p of parts) {
    if (p.kind !== 'used' || p.tokens <= 0) continue
    sum += p.tokens
    const end = Math.min(width, Math.round((sum / max) * width))
    if (end > drawn) out.push({ color: p.color, cells: end - drawn })
    drawn = Math.max(drawn, end)
  }
  return { used: out, rest: width - drawn }
}

const top = (items: Item[], n: number) =>
  [...items].sort((a, b) => b.tokens - a.tokens).slice(0, n)

export const toDetails = (b: SessionContextBreakdown, home: string): Details => {
  const servers = new Map<string, Item>()
  for (const t of b.mcpTools) {
    if (!t.isLoaded) continue
    const s = servers.get(t.serverName) ?? { name: t.serverName, detail: '', tokens: 0 }
    s.tokens += t.tokens
    s.detail = `${Number(s.detail || 0) + 1}`
    servers.set(t.serverName, s)
  }
  const tilde = (p: string) => (home && p.startsWith(home) ? `~${p.slice(home.length)}` : p)

  return {
    total: b.totalTokens,
    max: b.rawMaxTokens,
    percent: b.percentage,
    parts: b.categories.map(c => ({ name: c.name, tokens: c.tokens, color: c.color, kind: c.kind })),
    compactAt: b.isAutoCompactEnabled ? (b.autoCompactThreshold ?? null) : null,
    mcp: top([...servers.values()].map(s => ({ ...s, detail: `${s.detail} Tools` })), 8),
    memory: top(b.memoryFiles.map(f => ({ name: tilde(f.path), detail: f.type, tokens: f.tokens })), 8),
    skills: top(
      (b.skills?.skillFrontmatter ?? []).map(s => ({ name: s.name, detail: s.pluginName ?? s.source, tokens: s.tokens })),
      6,
    ),
    skillsTotal: b.skills?.tokens ?? 0,
    agentsTotal: b.agents.reduce((n, a) => n + a.tokens, 0),
  }
}

/** Keeps the 10 largest results; tokens estimated at 4 characters each. */
export const addHeavy = (list: Heavy[], one: Heavy) =>
  [...list, one].sort((a, b) => b.tokens - a.tokens).slice(0, 10)

const LABEL_KEYS = ['file_path', 'command', 'pattern', 'url', 'query', 'description', 'prompt', 'path', 'skill']

export const labelOf = (input: Record<string, unknown>) => {
  for (const k of LABEL_KEYS) {
    const v = input[k]
    if (typeof v === 'string' && v.trim()) return v.replace(/\s+/g, ' ').trim()
  }
  return ''
}

const LIMIT_LABEL: Record<string, string> = { five_hour: '5h', seven_day: '7d', spend_limit: 'Budget' }

export const limitLabel = (kind: string) => LIMIT_LABEL[kind] ?? kind.replace(/_/g, ' ')

/** Time left until a window resets, coarse enough to stay true for a minute. */
export const until = (at: number | null, nowMs: number) => {
  if (at === null) return ''
  const min = Math.max(0, Math.round((at - nowMs) / 60_000))
  if (min < 60) return `${min}m`
  const h = Math.floor(min / 60)
  if (h < 48) return `${h}h${String(min % 60).padStart(2, '0')}`
  return `${Math.round(h / 24)}d`
}

export const toLimits = (list: readonly { kind: string; percentUsed: number; resetsAt?: string }[]): Limit[] =>
  list.map(l => {
    const at = l.resetsAt ? Date.parse(l.resetsAt) : NaN
    return { kind: l.kind, percent: l.percentUsed, resetsAt: Number.isNaN(at) ? null : at }
  })

/** Input side of one response: what the window held when the model answered. */
export const stepTokens = (u: ModelUsage) =>
  u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens

/** `tokens`, when given, is a fresher reading (a step that just answered) than the session's. */
async function measure($: EngineInterface, tokens?: number) {
  const usage = await $.session.usage({ breakdown: 'summary' })
  const f = toFill(usage.context)
  await update($, fill, () =>
    tokens === undefined ? f : { ...f, tokens, percent: Math.round((tokens / f.window) * 100) },
  )
  await update($, limits, () => toLimits(usage.rateLimits))
  await update($, now, () => Date.now())
  const b = usage.context.breakdown
  if (b) {
    const home = (await $.env.get('HOME')) ?? ''
    await update($, details, () => toDetails(b, home))
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await $.command.register({
      name: 'context-details',
      description: 'Shows what is using up the context window',
    })
    await measure($)
    // keeps the reset countdowns honest while the session sits idle
    $.clock.every(60_000, () => {
      void update($, now, () => Date.now())
    })
    return result
  })

  on('session.measure', async ($, e, next) => {
    const result = await next(e)
    await measure($)
    return result
  })

  // Live during a turn: each answered model call of the main loop measures again.
  on('turn.step', async function* ($, e, next) {
    const r = yield* next(e)
    if (e.agentId === undefined && r.usage) {
      // the bar is a nicety: a failed reading must never touch the turn
      try {
        await measure($, stepTokens(r.usage))
      } catch {}
    }
    return r
  })

  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined && !('skip' in result)) await update($, heavy, () => [])
    return result
  }).catch(($, e, next) => next(e))

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') await update($, heavy, () => [])
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId === undefined && ran.text) {
      const one: Heavy = {
        id: e.tool_use_id,
        tool: e.tool,
        label: labelOf(e as unknown as Record<string, unknown>).slice(0, 120),
        tokens: Math.round(ran.text.length / 4),
      }
      await update($, heavy, list => addHeavy(list, one))
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'context-details' }, async $ => {
    await measure($)
    await $.ui.open({ id: PANE, title: 'Context' })
    return { text: 'Context details opened.' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)

    const current = await read($, fill)
    const d = await read($, details)
    const { Box, Text, Button } = $.ui.resolve(e)

    if (d === null && (current === null || current.percent === null || current.tokens === null)) {
      return (
        <Box>
          <Text dimColor>
            Context ░░░░░░░░░░ no reading yet
            {current ? ` · window ${kilo(current.window)}` : ''}
          </Text>
        </Box>
      )
    }

    const percent = d?.percent ?? current?.percent ?? 0
    const used = d?.total ?? current?.tokens ?? 0
    const max = d?.max ?? current?.window ?? 1
    const cols = e.props.bodyColumns
    const color = tone(percent)

    const lim = await read($, limits)
    const nowMs = (await read($, now)) || Date.now()
    const showMini = cols >= 110
    const showReset = cols >= 90
    const shown = lim.map(l => ({
      ...l,
      label: limitLabel(l.kind),
      pct: `${Math.round(l.percent)}%`,
      reset: showReset ? until(l.resetsAt, nowMs) : '',
      mini: showMini ? bar(l.percent, 5) : null,
    }))
    const lenOf = (l: (typeof shown)[number]) =>
      l.label.length + 1 + (l.mini ? 6 : 0) + l.pct.length + (l.reset ? l.reset.length + 2 : 0)
    // 5h on the first row, the week (and any other window) on the second
    const first = shown.filter(l => l.kind === 'five_hour')
    const second = shown.filter(l => l.kind !== 'five_hour')
    const limitW = shown.length ? Math.max(...[first, second].map(g => g.reduce((n, l) => n + lenOf(l), 0) + Math.max(0, g.length - 1) * 3)) : 0
    const width = Math.max(8, Math.min(40, cols - 30 - limitW - 10))

    const barRow = d
      ? (() => {
          const sg = segments(d.parts, d.max, width)
          return [
            ...sg.used.map((seg, i) => (
              <Text key={`s${i}`} color={seg.color}>
                {'█'.repeat(seg.cells)}
              </Text>
            )),
            <Text key="rest" dimColor>
              {'░'.repeat(sg.rest)}
            </Text>,
          ]
        })()
      : (() => {
          const b = bar(percent, width)
          return [
            <Text key="f" color={color}>{b.filled}</Text>,
            <Text key="e" dimColor>{b.empty}</Text>,
          ]
        })()

    const legendRoom = cols - (limitW ? limitW + 2 : 0)
    const legend: Part[] = []
    let taken = 0
    for (const part of d ? d.parts.filter(x => x.kind === 'used' && x.tokens > 0).sort((a, b) => b.tokens - a.tokens) : []) {
      const len = 2 + part.name.length + 1 + kilo(part.tokens).length + (legend.length ? 2 : 0)
      if (legend.length >= 5 || taken + len > legendRoom) break
      legend.push(part)
      taken += len
    }

    const limitBox = (key: string, group: typeof shown) => (
      <Box key={key} width={limitW}>
        {group.map((l, i) => (
          <Box key={`l-${l.kind}`}>
            {i > 0 && <Text dimColor> │ </Text>}
            <Text dimColor>{l.label} </Text>
            {l.mini && <Text color={tone(l.percent)}>{l.mini.filled}</Text>}
            {l.mini && <Text dimColor>{l.mini.empty} </Text>}
            <Text color={tone(l.percent)} bold>
              {l.pct}
            </Text>
            {l.reset && <Text dimColor> ↻{l.reset}</Text>}
          </Box>
        ))}
      </Box>
    )

    return (
      <Box flexDirection="column">
        <Box justifyContent="space-between">
          <Box>
            <Text dimColor>Context </Text>
            {barRow}
            <Text color={color} bold>
              {' '}
              {percent}%
            </Text>
            <Text dimColor wrap="truncate-end">
              {' '}
              · {kilo(used)} / {kilo(max)}
            </Text>
          </Box>
          <Box>
            <Button
              key="details"
              label="Details"
              plain
              dimColor
              onPress={() => $.ui.open({ id: PANE, title: 'Context' })}
            />
            {limitW > 0 && <Text>  </Text>}
            {limitW > 0 && limitBox('row1', first)}
          </Box>
        </Box>
        {(legend.length > 0 || second.length > 0) && (
          <Box justifyContent="space-between">
            <Box columnGap={2}>
              {legend.map(part => (
                <Box key={part.name}>
                  <Text color={part.color}>■ </Text>
                  <Text dimColor>
                    {part.name} {kilo(part.tokens)}
                  </Text>
                </Box>
              ))}
            </Box>
            {limitW > 0 && limitBox('row2', second)}
          </Box>
        )}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const d = await read($, details)
    const big = await read($, heavy)
    const cols = e.props.bodyColumns
    const nameW = Math.max(16, Math.min(48, cols - 28))
    const cut = (s: string) => (s.length > nameW ? `${s.slice(0, nameW - 1)}…` : s)

    const row = (key: string, name: string, tokens: number, extra: string, color?: string) => (
      <Box key={key}>
        {color !== undefined && <Text color={color}>■ </Text>}
        <Box width={nameW}>
          <Text wrap="truncate-end">{cut(name)}</Text>
        </Box>
        <Box width={8} justifyContent="flex-end">
          <Text bold>{kilo(tokens)}</Text>
        </Box>
        <Text dimColor> {extra}</Text>
      </Box>
    )

    const section = (key: string, title: string) => (
      <Box key={key} marginTop={1}>
        <Text bold underline>
          {title}
        </Text>
      </Box>
    )

    if (d === null) {
      return <Text dimColor>No breakdown yet — it arrives with the first response.</Text>
    }

    const share = (n: number) => `${((n / d.max) * 100).toFixed(1)}%`

    return (
      <Box flexDirection="column">
        <Text>
          <Text bold color={tone(d.percent)}>
            {d.percent}%
          </Text>
          <Text dimColor>
            {' '}
            · {kilo(d.total)} of {kilo(d.max)} tokens
            {d.compactAt ? ` · auto-compact at ${kilo(d.compactAt)}` : ' · auto-compact off'}
          </Text>
        </Text>

        {section('h-cat', 'Categories')}
        {d.parts
          .filter(p => p.tokens > 0)
          .map(p =>
            row(
              `c-${p.name}`,
              p.name,
              p.tokens,
              p.kind === 'deferred' ? 'on demand, not counted' : share(p.tokens),
              p.color,
            ),
          )}

        {section('h-heavy', 'Largest tool results (since /clear or compact, ≈)')}
        {big.length === 0 ? (
          <Text dimColor>none yet</Text>
        ) : (
          big.map(h => row(`h-${h.id}`, h.label ? `${h.tool}: ${h.label}` : h.tool, h.tokens, ''))
        )}

        {d.mcp.length > 0 && section('h-mcp', 'MCP servers (loaded tool schemas)')}
        {d.mcp.map(m => row(`m-${m.name}`, m.name, m.tokens, m.detail))}

        {d.memory.length > 0 && section('h-mem', 'Memory files')}
        {d.memory.map(m => row(`f-${m.name}`, m.name, m.tokens, m.detail))}

        {d.skills.length > 0 && section('h-sk', `Skills (listing total ${kilo(d.skillsTotal)})`)}
        {d.skills.map(s => row(`k-${s.name}`, s.name, s.tokens, s.detail))}

        {d.agentsTotal > 0 && section('h-ag', 'Agent descriptions')}
        {d.agentsTotal > 0 && row('a-total', 'all together', d.agentsTotal, '')}

        <Box marginTop={1}>
          <Text dimColor>Estimated like /context (summary). Exact count: /context</Text>
        </Box>
      </Box>
    )
  })
}
