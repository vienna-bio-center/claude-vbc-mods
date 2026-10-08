export type Fill = { tokens: number | null; window: number; percent: number | null }

export type Part = { name: string; tokens: number; color: string; kind: 'used' | 'free' | 'buffer' | 'deferred' }

export type Item = { name: string; detail: string; tokens: number }

export type Details = {
  total: number
  max: number
  percent: number
  parts: Part[]
  compactAt: number | null
  mcp: Item[]
  memory: Item[]
  skills: Item[]
  skillsTotal: number
  agentsTotal: number
}

export type Limit = { kind: string; percent: number; resetsAt: number | null }

export type Heavy = { id: string; tool: string; label: string; tokens: number }

declare module 'claude-code' {
  interface PluginState {
    'context-meter': {
      fill: Fill | null
      details: Details | null
      heavy: Heavy[]
      limits: Limit[]
      now: number
    }
  }
}
