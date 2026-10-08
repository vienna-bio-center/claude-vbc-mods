// Reads a shell command the way bash would split it and finds the parts that delete files.
// Pure: no `$`, so it is tested on its own. What it can't read safely it reports as `opaque`.

/** One shell word: `text` as bash would pass it, `pattern` with quoted glob/brace/tilde characters escaped. */
export type Word = { text: string; pattern: string; isDynamic: boolean }

export type Found =
  | { kind: 'paths'; tool: string; cwd: string[]; isCwdKnown: boolean; words: Word[] }
  | { kind: 'find'; cwd: string[]; isCwdKnown: boolean; argv: string[] | null; text: string }
  | { kind: 'git-clean'; cwd: string[]; isCwdKnown: boolean; argv: string[] | null; text: string }
  | { kind: 'opaque'; text: string; why: string }

export type Analysis = {
  found: Found[]
  /** True when every part of the command is a delete (or a `cd`): nothing else would run. */
  isOnlyDeletes: boolean
}

type Token = { type: 'word'; word: Word } | { type: 'op'; op: string }

const SPECIAL = /[\\*?[\]{}~]/g
const isGlobPattern = (pattern: string) => /(^|[^\\])(\\\\)*[*?[]/.test(pattern)

/** Index of the `)` that closes the `(` at `open`, skipping quotes; -1 when unclosed. */
const closing = (src: string, open: number) => {
  let depth = 0
  for (let i = open; i < src.length; i++) {
    const c = src[i]
    if (c === '\\') i++
    else if (c === "'") {
      const end = src.indexOf("'", i + 1)
      if (end < 0) return -1
      i = end
    } else if (c === '"') {
      i++
      while (i < src.length && src[i] !== '"') i += src[i] === '\\' ? 2 : 1
    } else if (c === '(') depth++
    else if (c === ')' && --depth === 0) return i
  }
  return -1
}

/** Splits `src` into words and operators; command substitutions go to `inner` as well. */
export const lex = (src: string): { tokens: Token[]; inner: string[] } => {
  const tokens: Token[] = []
  const inner: string[] = []
  let cur: Word | null = null
  const begin = (): Word => (cur ??= { text: '', pattern: '', isDynamic: false })
  const flush = () => {
    if (cur !== null) tokens.push({ type: 'word', word: cur })
    cur = null
  }
  const lit = (s: string) => {
    const w = begin()
    w.text += s
    w.pattern += s.replace(SPECIAL, '\\$&')
  }
  const dynamic = (raw: string) => {
    const w = begin()
    w.text += raw
    w.pattern += raw.replace(SPECIAL, '\\$&')
    w.isDynamic = true
  }

  // `$...` or a backtick at i: reads to its end, returns the index after it
  const dollar = (i: number): number => {
    if (src[i] === '`') {
      let end = i + 1
      while (end < src.length && src[end] !== '`') end += src[end] === '\\' ? 2 : 1
      inner.push(src.slice(i + 1, end))
      dynamic(src.slice(i, end + 1))
      return end + 1
    }
    const n = src[i + 1]
    if (n === '(') {
      const end = closing(src, i + 1)
      const stop = end < 0 ? src.length : end + 1
      if (src[i + 2] !== '(') inner.push(src.slice(i + 2, stop - 1))
      dynamic(src.slice(i, stop))
      return stop
    }
    if (n === '{') {
      const end = src.indexOf('}', i + 2)
      const stop = end < 0 ? src.length : end + 1
      dynamic(src.slice(i, stop))
      return stop
    }
    if (n === "'") {
      let end = i + 2
      let text = ''
      while (end < src.length && src[end] !== "'") {
        if (src[end] === '\\' && end + 1 < src.length) {
          const e = src[end + 1]
          text += e === 'n' ? '\n' : e === 't' ? '\t' : e
          end += 2
        } else text += src[end++]
      }
      lit(text)
      return end + 1
    }
    const name = /^(?:[A-Za-z_][A-Za-z0-9_]*|[0-9@*#?$!-])/.exec(src.slice(i + 1))
    if (name === null) {
      lit('$')
      return i + 1
    }
    dynamic(src.slice(i, i + 1 + name[0].length))
    return i + 1 + name[0].length
  }

  let i = 0
  while (i < src.length) {
    const c = src[i]!
    if (c === ' ' || c === '\t' || c === '\r') {
      flush()
      i++
    } else if (c === '\\') {
      if (src[i + 1] !== '\n') lit(src[i + 1] ?? '')
      i += 2
    } else if (c === '#' && cur === null) {
      while (i < src.length && src[i] !== '\n') i++
    } else if (c === "'") {
      const end = src.indexOf("'", i + 1)
      lit(end < 0 ? src.slice(i + 1) : src.slice(i + 1, end))
      i = end < 0 ? src.length : end + 1
    } else if (c === '"') {
      begin()
      i++
      while (i < src.length && src[i] !== '"') {
        if (src[i] === '\\' && '"\\$`\n'.includes(src[i + 1] ?? '')) {
          if (src[i + 1] !== '\n') lit(src[i + 1]!)
          i += 2
        } else if (src[i] === '$' || src[i] === '`') i = dollar(i)
        else lit(src[i++]!)
      }
      i++
    } else if (c === '$' || c === '`') {
      i = dollar(i)
    } else if (c === '>' || c === '<') {
      const w = cur as Word | null
      if (w !== null && /^\d+$/.test(w.text) && w.text === w.pattern) cur = null
      flush()
      const op = /^(<<<|<<-?|<>|>>|>\||>&|<&|>|<)/.exec(src.slice(i))![0]
      if ((op === '<' || op === '>') && src[i + 1] === '(') {
        tokens.push({ type: 'op', op: '(' })
        i += 2
      } else {
        tokens.push({ type: 'op', op: op === '<<' || op === '<<-' ? '<<' : '>' })
        i += op.length
      }
    } else if (c === '&' && src[i + 1] === '>') {
      flush()
      tokens.push({ type: 'op', op: '>' })
      i += src[i + 2] === '>' ? 3 : 2
    } else if (';&|()\n'.includes(c)) {
      flush()
      const op = /^(;;|&&|\|\||\|&|[;&|()\n])/.exec(src.slice(i))![0]
      tokens.push({ type: 'op', op })
      i += op.length
    } else {
      const w = begin()
      w.text += c
      w.pattern += c
      i++
    }
  }
  flush()
  return { tokens, inner }
}

const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', '!', '{', '}', 'time'])
const DELETERS = new Set(['rm', 'unlink', 'rmdir', 'shred', 'srm', 'trash', 'trash-put', 'rimraf'])
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh'])
const SAFE_EXTRA = new Set(['cd', 'pushd', 'popd', 'true', ':'])

const baseName = (s: string) => s.slice(s.lastIndexOf('/') + 1)
const isFlag = (w: Word) => w.text.length > 1 && w.text.startsWith('-')

/** Drops wrappers that run the command after them (`sudo`, `env`, `nice`, ...). */
const unwrap = (words: Word[]): Word[] => {
  let rest = words
  for (;;) {
    while (rest.length > 0 && (KEYWORDS.has(rest[0]!.text) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[0]!.text)))
      rest = rest.slice(1)
    const name = rest[0] === undefined ? '' : baseName(rest[0].text)
    const withArg: Record<string, string[]> = {
      sudo: ['-u', '-g', '-C', '-D', '-h', '-p', '-r', '-t', '-U', '-T'],
      doas: ['-u', '-C'],
      env: ['-u', '-C', '-S'],
      nice: ['-n'],
      ionice: ['-c', '-n', '-p'],
      timeout: ['-s', '-k', '--signal', '--kill-after'],
      stdbuf: ['-i', '-o', '-e'],
      exec: ['-a'],
      command: [],
      builtin: [],
      nohup: [],
      caffeinate: ['-t', '-w'],
    }
    const args = withArg[name]
    if (args === undefined) return rest
    if (name === 'command' && rest.some(w => w.text === '-v' || w.text === '-V')) return []
    rest = rest.slice(1)
    while (rest.length > 0 && (isFlag(rest[0]!) || (name === 'env' && rest[0]!.text.includes('=')))) {
      rest = rest.slice(args.includes(rest[0]!.text) ? 2 : 1)
    }
    if (name === 'timeout') rest = rest.slice(1)
  }
}

/** The operands after the flags; `--` ends the flags. `withArg` names flags that take the next word. */
const operands = (args: Word[], withArg: string[] = []) => {
  const out: Word[] = []
  let isFlagsDone = false
  for (let i = 0; i < args.length; i++) {
    const w = args[i]!
    if (!isFlagsDone && w.text === '--') isFlagsDone = true
    else if (!isFlagsDone && isFlag(w)) i += withArg.includes(w.text) ? 1 : 0
    else out.push(w)
  }
  return out
}

const FIND_ACTIONS = ['-exec', '-execdir', '-ok', '-okdir']
const FIND_WRITES = /^-(fprint0?|fprintf|fls|delete)$/

const readFind = (args: Word[], ctx: Ctx): Found | null => {
  let i = 0
  const opts: string[] = []
  while (i < args.length && /^-[HLP]$|^-D$|^-O\d$/.test(args[i]!.text)) {
    opts.push(args[i]!.text)
    if (args[i]!.text === '-D') opts.push(args[++i]?.text ?? '')
    i++
  }
  const roots: Word[] = []
  while (i < args.length && !/^[-(!]/.test(args[i]!.text)) roots.push(args[i++]!)
  const expr = args.slice(i)
  const kept: Word[] = []
  let deletes = false
  for (let j = 0; j < expr.length; j++) {
    const w = expr[j]!
    if (w.text === '-delete') {
      deletes = true
      continue
    }
    if (FIND_ACTIONS.includes(w.text) && DELETERS.has(baseName(expr[j + 1]?.text ?? ''))) {
      deletes = true
      while (j < expr.length && expr[j]!.text !== ';' && expr[j]!.text !== '+') j++
      continue
    }
    kept.push(w)
  }
  if (!deletes) return null
  const text = ['find', ...args.map(w => w.text)].join(' ')
  const isUnsafe = [...roots, ...kept].some(w => w.isDynamic || FIND_ACTIONS.includes(w.text) || FIND_WRITES.test(w.text))
  const argv = isUnsafe
    ? null
    : ['find', ...opts, ...(roots.length > 0 ? roots.map(w => w.text) : ['.']), ...(kept.length > 0 ? ['(', ...kept.map(w => w.text), ')'] : []), '-print']
  return { kind: 'find', cwd: [...ctx.cwd], isCwdKnown: ctx.isCwdKnown, argv, text }
}

const readGit = (args: Word[], ctx: Ctx): Found | null => {
  const cwd = [...ctx.cwd]
  let isCwdKnown = ctx.isCwdKnown
  const globals: string[] = []
  let i = 0
  while (i < args.length && isFlag(args[i]!)) {
    const w = args[i]!
    if (w.text === '-C') {
      const dir = args[++i]
      if (dir === undefined || dir.isDynamic) isCwdKnown = false
      else cwd.push(dir.text)
    } else if (w.text === '-c' || w.text === '--git-dir' || w.text === '--work-tree' || w.text === '--namespace') {
      globals.push(w.text, args[++i]?.text ?? '')
    } else globals.push(w.text)
    i++
  }
  const sub = args[i]?.text
  const rest = args.slice(i + 1)
  if (sub === 'rm') {
    if (rest.some(w => w.text === '--cached' || w.text === '-n' || w.text === '--dry-run')) return null
    const words = operands(rest)
    return words.length === 0 ? null : { kind: 'paths', tool: 'git rm', cwd, isCwdKnown, words }
  }
  if (sub !== 'clean') return null
  if (rest.some(w => w.text === '--dry-run' || /^-[a-z]*n/.test(w.text) && !w.text.startsWith('--'))) return null
  const text = ['git', ...args.map(w => w.text)].join(' ')
  if (args.some(w => w.isDynamic)) return { kind: 'git-clean', cwd, isCwdKnown, argv: null, text }
  const flags: string[] = []
  for (const w of rest) {
    if (w.text === '--force' || w.text === '--interactive') continue
    if (/^-[a-zA-Z]+$/.test(w.text)) {
      const kept = w.text.slice(1).replace(/[fi]/g, '')
      if (kept !== '') flags.push(`-${kept}`)
    } else flags.push(w.text)
  }
  return { kind: 'git-clean', cwd, isCwdKnown, argv: ['git', ...globals, 'clean', '-n', ...flags], text }
}

type Ctx = { cwd: string[]; isCwdKnown: boolean; found: Found[]; others: number; depth: number }

/** One simple command: what it deletes goes to `ctx.found`, a `cd` moves `ctx.cwd`. */
const readCommand = (raw: Word[], ctx: Ctx) => {
  const words = unwrap(raw)
  const head = words[0]
  if (head === undefined) return
  const name = baseName(head.text)
  const args = words.slice(1)
  if (head.isDynamic) {
    ctx.others++
    return
  }

  if (name === 'cd' || name === 'pushd') {
    const dir = operands(args)[0]
    if (dir === undefined) ctx.cwd.push('~')
    else if (dir.isDynamic || dir.text === '-') ctx.isCwdKnown = false
    else ctx.cwd.push(dir.text)
    return
  }
  if (name === 'popd') {
    ctx.isCwdKnown = false
    return
  }
  if (DELETERS.has(name)) {
    const words = operands(args, name === 'shred' ? ['-n', '-s', '--iterations', '--size', '--random-source'] : [])
    if (words.length > 0) ctx.found.push({ kind: 'paths', tool: name, cwd: [...ctx.cwd], isCwdKnown: ctx.isCwdKnown, words })
    return
  }
  if (name === 'gio' && (args[0]?.text === 'trash' || args[0]?.text === 'remove')) {
    const words = operands(args.slice(1))
    if (words.length > 0) ctx.found.push({ kind: 'paths', tool: `gio ${args[0]!.text}`, cwd: [...ctx.cwd], isCwdKnown: ctx.isCwdKnown, words })
    return
  }
  if (name === 'find') {
    const found = readFind(args, ctx)
    if (found !== null) ctx.found.push(found)
    else ctx.others++
    return
  }
  if (name === 'git') {
    const found = readGit(args, ctx)
    if (found !== null) ctx.found.push(found)
    else ctx.others++
    return
  }
  if (name === 'xargs') {
    let i = 0
    while (i < args.length && isFlag(args[i]!)) i += ['-I', '-n', '-P', '-L', '-d', '-s', '-a', '-E'].includes(args[i]!.text) ? 2 : 1
    const run = unwrap(args.slice(i))[0]
    if (run !== undefined && DELETERS.has(baseName(run.text)))
      ctx.found.push({ kind: 'opaque', text: words.map(w => w.text).join(' '), why: 'deletes whatever the command before it lists' })
    else ctx.others++
    return
  }
  if (name === 'rsync') {
    if (args.some(w => /^--(delete|remove-source-files)/.test(w.text)))
      ctx.found.push({ kind: 'opaque', text: words.map(w => w.text).join(' '), why: 'removes files at the destination that the source lacks' })
    ctx.others++
    return
  }
  if ((SHELLS.has(name) || name === 'eval') && ctx.depth < 4) {
    const dashC = args.findIndex(w => /^-[a-z]*c$/.test(w.text))
    const script = name === 'eval' ? args.map(w => w.text).join(' ') : dashC < 0 ? undefined : args[dashC + 1]?.text
    if (script !== undefined) {
      const sub = analyze(script, { ...ctx, cwd: [...ctx.cwd], found: [], others: 0, depth: ctx.depth + 1 })
      ctx.found.push(...sub.found)
      if (!sub.isOnlyDeletes) ctx.others++
      return
    }
  }
  if (!SAFE_EXTRA.has(name)) ctx.others++
}

const analyze = (command: string, ctx: Ctx): Analysis => {
  const { tokens, inner } = lex(command)
  const stack: { cwd: string[]; isCwdKnown: boolean }[] = []
  let words: Word[] = []
  let skipNext = false
  let hasRedirect = false
  const end = () => {
    readCommand(words, ctx)
    words = []
  }
  for (const t of tokens) {
    if (t.type === 'word') {
      if (skipNext) skipNext = false
      else words.push(t.word)
      continue
    }
    if (t.op === '>' || t.op === '<<') {
      skipNext = true
      hasRedirect = true
      continue
    }
    end()
    if (t.op === '(') stack.push({ cwd: [...ctx.cwd], isCwdKnown: ctx.isCwdKnown })
    if (t.op === ')') Object.assign(ctx, stack.pop() ?? {})
    if (t.op === '|' || t.op === '|&') ctx.others++
  }
  end()
  for (const sub of inner) {
    if (ctx.depth >= 4) break
    const nested = analyze(sub, { ...ctx, cwd: [...ctx.cwd], found: [], others: 0, depth: ctx.depth + 1 })
    ctx.found.push(...nested.found)
    ctx.others++
  }
  return { found: ctx.found, isOnlyDeletes: ctx.others === 0 && !hasRedirect && ctx.found.every(f => f.kind !== 'opaque') }
}

/** What the command would delete, and whether deleting is all it does. */
export const findDeletes = (command: string): Analysis =>
  analyze(command, { cwd: [], isCwdKnown: true, found: [], others: 0, depth: 0 })

/** Expands `{a,b}` and `{1..3}` in an escaped pattern, as bash does before globbing. */
export const expandBraces = (pattern: string): string[] => {
  let depth = 0
  let open = -1
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === '\\') {
      i++
      continue
    }
    if (c === '{') {
      if (depth++ === 0) open = i
    } else if (c === '}' && depth > 0 && --depth === 0) {
      const body = pattern.slice(open + 1, i)
      const pre = pattern.slice(0, open)
      const post = pattern.slice(i + 1)
      const range = /^(-?\d+)\.\.(-?\d+)$/.exec(body)
      const parts: string[] = []
      if (range !== null) {
        const [a, b] = [Number(range[1]), Number(range[2])]
        if (Math.abs(b - a) <= 1000) for (let n = a; a <= b ? n <= b : n >= b; n += a <= b ? 1 : -1) parts.push(`${n}`)
      } else {
        let d = 0
        let from = 0
        for (let j = 0; j < body.length; j++) {
          if (body[j] === '\\') j++
          else if (body[j] === '{') d++
          else if (body[j] === '}') d--
          else if (body[j] === ',' && d === 0) {
            parts.push(body.slice(from, j))
            from = j + 1
          }
        }
        if (parts.length === 0) return expandBraces(post).map(p => `${pre}{${body}}${p}`)
        parts.push(body.slice(from))
      }
      return parts.flatMap(part => expandBraces(pre + part + post))
    }
  }
  return [pattern]
}

export const hasGlob = isGlobPattern

/** Drops the escapes from a pattern without glob characters. */
export const unescape = (pattern: string) => pattern.replace(/\\(.)/g, '$1')

/** One path segment's glob as a RegExp; `*` and `?` skip a leading dot as bash does. */
export const segmentRegex = (segment: string): RegExp => {
  let out = ''
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i]!
    if (c === '\\') out += (segment[++i] ?? '').replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
    else if (c === '*') out += '[^/]*'
    else if (c === '?') out += '[^/]'
    else if (c === '[') {
      const end = segment.indexOf(']', i + 2)
      if (end < 0) out += '\\['
      else {
        let body = segment.slice(i + 1, end)
        const isNegated = body.startsWith('!') || body.startsWith('^')
        if (isNegated) body = body.slice(1)
        out += `[${isNegated ? '^' : ''}${body.replace(/\\/g, '\\\\')}]`
        i = end
      }
    } else out += c.replace(/[.+^${}()|\\/]/g, '\\$&')
  }
  const dotSafe = segment.startsWith('.') || segment.startsWith('\\.') ? '' : '(?!\\.)'
  return new RegExp(`^${dotSafe}${out}$`)
}

/** Joins and folds `.` and `..` (POSIX paths). */
export const joinPath = (base: string, path: string) => {
  const parts = (path.startsWith('/') ? path : `${base}/${path}`).split('/')
  const out: string[] = []
  for (const p of parts) {
    if (p === '' || p === '.') continue
    if (p === '..') out.pop()
    else out.push(p)
  }
  return `/${out.join('/')}`
}

/** An absolute path with the home folder written `~`. */
export const tilde = (abs: string, home: string) =>
  home !== '' && (abs === home || abs.startsWith(`${home}/`)) ? `~${abs.slice(home.length)}` : abs

/** A path for display: relative to `cwd` inside it, `~` for home, absolute otherwise. */
export const showPath = (abs: string, cwd: string, home: string) =>
  abs === cwd ? '.' : abs.startsWith(`${cwd}/`) ? abs.slice(cwd.length + 1) : tilde(abs, home)

export const bytes = (n: number) =>
  n >= 1024 ** 3
    ? `${(n / 1024 ** 3).toFixed(1)} GB`
    : n >= 1024 ** 2
      ? `${(n / 1024 ** 2).toFixed(1)} MB`
      : n >= 1024
        ? `${Math.round(n / 1024)} KB`
        : `${n} B`
