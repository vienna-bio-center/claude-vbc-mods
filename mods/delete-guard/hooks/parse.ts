// Reads a shell command the way bash would split it and finds the parts that delete files.
// Pure: no `$`, so it is tested on its own. What it can't read safely it reports as `opaque`.

/** One shell word: `text` as bash would pass it, `pattern` with quoted glob/brace/tilde characters escaped. */
export type Word = { text: string; pattern: string; isDynamic: boolean }

export type Found =
  | { kind: 'paths'; tool: string; cwd: string[]; isCwdKnown: boolean; words: Word[]; change?: string }
  | { kind: 'find'; cwd: string[]; isCwdKnown: boolean; argv: string[] | null; text: string }
  | { kind: 'git-clean'; cwd: string[]; isCwdKnown: boolean; argv: string[] | null; rootArgv: string[]; text: string }
  /**
   * A file written from the start (`>`, `cp`, `tee`, ...): asked about only when
   * it exists (and, with `isOnlyNonEmpty`, holds something). `intoDir`: `dest`
   * is a folder the `sources` go into; `null` when that depends on what `dest` is.
   */
  | {
      kind: 'overwrite'
      tool: string
      cwd: string[]
      isCwdKnown: boolean
      dest: Word
      sources: Word[]
      intoDir: boolean | null
      isOnlyNonEmpty: boolean
    }
  /** `git reset --hard`, `restore`, `checkout -- ...`: `argv` lists the changed files (repo-relative, `rootArgv` finds the repo). */
  | {
      kind: 'git-discard'
      cwd: string[]
      isCwdKnown: boolean
      scope: 'worktree' | 'all'
      argv: string[] | null
      rootArgv: string[]
      text: string
      note?: string
    }
  | { kind: 'opaque'; text: string; why: string }

export type Analysis = {
  found: Found[]
  /** True when every part of the command is a delete (or a `cd`): nothing else would run. */
  isOnlyDeletes: boolean
}

/** `write` empties the file (`>`, `>|`, `&>`), `dup` is `>&` (a file, or a descriptor like `2>&1`). */
type Redirect = 'write' | 'append' | 'dup' | 'read' | 'heredoc'

type Token = { type: 'word'; word: Word } | { type: 'op'; op: string } | { type: 'redirect'; mode: Redirect }

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

/** The `$(...)` and backtick commands in a text that is not split into words (an unquoted here-doc body). */
const substitutions = (body: string): string[] => {
  const out: string[] = []
  for (let j = 0; j < body.length; j++) {
    if (body[j] === '\\') j++
    else if (body[j] === '$' && body[j + 1] === '(') {
      const end = closing(body, j + 1)
      out.push(body.slice(j + 2, end < 0 ? body.length : end))
      j = end < 0 ? body.length : end
    } else if (body[j] === '`') {
      const end = body.indexOf('`', j + 1)
      out.push(body.slice(j + 1, end < 0 ? body.length : end))
      j = end < 0 ? body.length : end
    }
  }
  return out
}

/** Splits `src` into words and operators; command substitutions go to `inner` as well. Here-doc bodies are text, not commands. */
export const lex = (src: string): { tokens: Token[]; inner: string[] } => {
  const tokens: Token[] = []
  const inner: string[] = []
  const heredocs: { delim: string; isStripped: boolean; isQuoted: boolean }[] = []
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
      // `$(( $(cmd) ))` runs cmd too
      else inner.push(...substitutions(src.slice(i + 3, stop - 2)))
      dynamic(src.slice(i, stop))
      return stop
    }
    if (n === '{') {
      const end = closing(src.replace(/[{}]/g, c => (c === '{' ? '(' : ')')), i + 1)
      const stop = end < 0 ? src.length : end + 1
      // `${X:-$(cmd)}` runs cmd when X is unset
      inner.push(...substitutions(src.slice(i + 2, stop - 1)))
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
        const mode: Redirect =
          op === '>' || op === '>|' ? 'write' : op === '>&' ? 'dup' : op === '>>' ? 'append' : op === '<<' || op === '<<-' ? 'heredoc' : 'read'
        tokens.push({ type: 'redirect', mode })
        i += op.length
        if (mode === 'heredoc') {
          // the delimiter is still lexed as the next word; its body starts after the line ends
          const d = /^[ \t]*(?:'([^']*)'|"([^"]*)"|(\\?)([^\s;&|<>()]+))/.exec(src.slice(i))
          if (d !== null)
            heredocs.push({
              delim: d[1] ?? d[2] ?? d[4]!.replace(/\\/g, ''),
              isStripped: op === '<<-',
              isQuoted: d[1] !== undefined || d[2] !== undefined || d[3] === '\\' || d[4]!.includes('\\'),
            })
        }
      }
    } else if (c === '&' && src[i + 1] === '>') {
      flush()
      tokens.push({ type: 'redirect', mode: src[i + 2] === '>' ? 'append' : 'write' })
      i += src[i + 2] === '>' ? 3 : 2
    } else if (';&|()\n'.includes(c)) {
      flush()
      const op = /^(;;|&&|\|\||\|&|[;&|()\n])/.exec(src.slice(i))![0]
      tokens.push({ type: 'op', op })
      i += op.length
      // skip the bodies of the here-docs opened on the line that just ended
      if (op === '\n')
        for (const h of heredocs.splice(0)) {
          let body = ''
          while (i < src.length) {
            const eol = src.indexOf('\n', i)
            const line = src.slice(i, eol < 0 ? src.length : eol)
            i = eol < 0 ? src.length : eol + 1
            if ((h.isStripped ? line.replace(/^\t+/, '') : line) === h.delim) break
            body += `${line}\n`
          }
          if (!h.isQuoted) inner.push(...substitutions(body))
        }
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
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

const baseName = (s: string) => s.slice(s.lastIndexOf('/') + 1)
const isFlag = (w: Word) => w.text.length > 1 && w.text.startsWith('-')
const literal = (text: string): Word => ({ text, pattern: text.replace(SPECIAL, '\\$&'), isDynamic: false })
const splitWords = (src: string) => lex(src).tokens.flatMap(t => (t.type === 'word' ? [t.word] : []))

/** A command named bare (found on PATH) or by a system path; `./rm` or `/tmp/x/git` are something else. */
const isSystemPath = (s: string) => !s.includes('/') || /^\/(usr\/)?s?bin\/[^/]+$/.test(s)

/**
 * The flag a word sets and its glued value, if any: `--name=value`, or in a
 * group of short flags (`-nu root`, `-uroot`, `-S'rm x'`) the first one that
 * takes a value, with the rest of the group as that value.
 */
const flagValue = (w: Word, withArg: string[]): [string, Word | undefined] => {
  if (w.text.startsWith('--')) return splitFlag(w)
  for (let k = 1; k < w.text.length; k++) {
    const flag = `-${w.text[k]}`
    if (!withArg.includes(flag)) continue
    const rest = w.text.slice(k + 1)
    return [flag, rest === '' ? undefined : { text: rest, pattern: rest.replace(SPECIAL, '\\$&'), isDynamic: w.isDynamic }]
  }
  return [w.text, undefined]
}

/** Splits `--name=value` into the flag and its value (a word of its own). */
const splitFlag = (w: Word): [string, Word | undefined] => {
  const at = w.text.indexOf('=')
  if (!w.text.startsWith('--') || at < 0) return [w.text, undefined]
  return [w.text.slice(0, at), { ...w, text: w.text.slice(at + 1), pattern: w.pattern.slice(w.pattern.indexOf('=') + 1) }]
}

/** Commands that run the command after them, with their flags that take a value. */
const WRAPPERS: Record<string, string[]> = {
  sudo: ['-u', '-g', '-C', '-D', '-h', '-p', '-r', '-t', '-U', '-T', '--user', '--group', '--close-from', '--chdir', '--host', '--prompt', '--role', '--type', '--other-user', '--command-timeout'],
  doas: ['-u', '-C'],
  env: ['-u', '-C', '-S', '--unset', '--chdir', '--split-string'],
  nice: ['-n', '--adjustment'],
  ionice: ['-c', '-n', '-p', '--class', '--classdata', '--pid'],
  timeout: ['-s', '-k', '--signal', '--kill-after'],
  stdbuf: ['-i', '-o', '-e', '--input', '--output', '--error'],
  exec: ['-a'],
  command: [],
  builtin: [],
  nohup: [],
  caffeinate: ['-t', '-w'],
  npx: ['-p', '--package', '-c', '--call', '-w', '--workspace'],
  bunx: ['-p', '--package'],
  pnpx: ['-p', '--package'],
}
/** `npm exec rimraf x` and the like run a package's command, as `npx` does. */
const RUNNERS: Record<string, string[]> = { npm: ['exec', 'x'], pnpm: ['exec', 'dlx'], yarn: ['exec', 'dlx'], bun: ['x'] }

/**
 * Drops wrappers that run the command after them (`sudo`, `env`, `npx`, ...).
 * `chdir` holds the folders a wrapper moves that one command into (`env -C`).
 */
const unwrap = (raw: Word[]): { words: Word[]; chdir: Word[]; isPlain: boolean } => {
  let rest = raw
  const chdir: Word[] = []
  let isPlain = true
  for (;;) {
    while (rest.length > 0 && (KEYWORDS.has(rest[0]!.text) || ASSIGNMENT.test(rest[0]!.text))) {
      // `PATH=… rm`, `LD_PRELOAD=… rm`: what runs is not the plain command
      if (ASSIGNMENT.test(rest[0]!.text)) isPlain = false
      rest = rest.slice(1)
    }
    if (rest.length === 0) return { words: rest, chdir, isPlain }
    let name = baseName(rest[0]!.text)
    if (RUNNERS[name]?.includes(rest[1]?.text ?? '')) {
      rest = rest.slice(1)
      name = 'npx'
    }
    const withArg = WRAPPERS[name]
    if (withArg === undefined) return { words: rest, chdir, isPlain }
    // a package runner fetches and runs code; `./sudo` is not sudo
    if (name === 'npx' || name === 'bunx' || name === 'pnpx' || !isSystemPath(rest[0]!.text)) isPlain = false
    rest = rest.slice(1)
    while (rest.length > 0 && (isFlag(rest[0]!) || (name === 'env' && rest[0]!.text.includes('=')))) {
      const w = rest[0]!
      rest = rest.slice(1)
      if (w.text === '--') break
      if (!isFlag(w)) {
        isPlain = false
        continue
      }
      // `command -v rm` only looks the command up
      if (name === 'command' && /^-[a-zA-Z]*[vV]/.test(w.text)) return { words: [], chdir, isPlain }
      const [flag, glued] = flagValue(w, withArg)
      if (!withArg.includes(flag)) continue
      const value = glued ?? rest[0]
      if (glued === undefined) rest = rest.slice(1)
      if (value === undefined) continue
      if (flag === '--chdir' || (name === 'env' && flag === '-C') || (name === 'sudo' && flag === '-D')) chdir.push(value)
      else if (name === 'env' && (flag === '-S' || flag === '--split-string')) rest = [...splitWords(value.text), ...rest]
      else if (name === 'npx' && (flag === '-c' || flag === '--call')) rest = [literal('sh'), literal('-c'), value]
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

/** What a found part does: only these count as a delete. */
const isDelete = (f: Found) => f.kind === 'paths' || f.kind === 'find' || f.kind === 'git-clean' || f.kind === 'opaque'

/** Reads a command that another one runs (`find -exec`, `xargs`) on its own. */
const subCommand = (words: Word[], ctx: Ctx, isCwdKnown = ctx.isCwdKnown): Ctx => {
  const sub: Ctx = { cwd: [...ctx.cwd], isCwdKnown, found: [], others: 0, depth: ctx.depth + 1 }
  if (ctx.depth < 4) readCommand(words, sub)
  else sub.others++
  return sub
}

/** Takes the stand-in for `{}` or xargs' input back out of what a sub-command found. */
const strip = (found: Found[], stand: Word): Found[] =>
  found.flatMap((f): Found[] => {
    if (f.kind === 'paths') {
      const words = f.words.filter(w => w !== stand)
      return words.length > 0 ? [{ ...f, words }] : []
    }
    if (f.kind === 'overwrite') return f.dest === stand ? [] : [{ ...f, sources: f.sources.filter(w => w !== stand) }]
    return [f]
  })

const FIND_ACTIONS = ['-exec', '-execdir', '-ok', '-okdir']
const FIND_WRITES = /^-(fprint0?|fprintf|fls)$/

/**
 * `find` with `-delete` or `-exec rm`: the same `find` with each delete swapped
 * in place for `-print` lists what it would delete, in the same order of tests.
 */
const readFind = (args: Word[], ctx: Ctx): { found: Found[]; isOnlyDeletes: boolean } | null => {
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
  const preview: string[] = []
  const extra: Found[] = []
  let deletes = false
  let hasDelete = false
  let isOther = false
  let isUnlistable = roots.some(w => w.isDynamic)
  for (let j = 0; j < expr.length; j++) {
    const w = expr[j]!
    if (w.text === '-delete') {
      deletes = hasDelete = true
      preview.push('-print')
      continue
    }
    if (FIND_ACTIONS.includes(w.text)) {
      const cmd: Word[] = []
      while (++j < expr.length && expr[j]!.text !== ';' && !(expr[j]!.text === '+' && expr[j - 1]?.text === '{}')) cmd.push(expr[j]!)
      const stand: Word = { text: '{}', pattern: '{}', isDynamic: true }
      const sub = subCommand(
        cmd.map(c => (c.text === '{}' ? stand : c)),
        ctx,
        ctx.isCwdKnown && !w.text.endsWith('dir'),
      )
      if (sub.found.some(isDelete)) {
        deletes = true
        preview.push('-print')
        extra.push(...strip(sub.found, stand))
        if (sub.others > 0) isOther = true
      } else isOther = isUnlistable = true
      continue
    }
    if (FIND_WRITES.test(w.text)) isOther = isUnlistable = true
    if (/^-(ls|printf|print0)$/.test(w.text) || w.isDynamic) isUnlistable = true
    // the command's own -print would list what is not deleted too; -true keeps the logic
    preview.push(w.text === '-print' ? '-true' : w.text)
  }
  if (!deletes) return null
  const text = ['find', ...args.map(w => w.text)].join(' ')
  const argv = isUnlistable
    ? null
    : ['find', ...opts, ...(roots.length > 0 ? roots.map(w => w.text) : ['.']), ...(hasDelete ? ['-depth'] : []), ...preview]
  return { found: [{ kind: 'find', cwd: [...ctx.cwd], isCwdKnown: ctx.isCwdKnown, argv, text }, ...extra], isOnlyDeletes: !isOther }
}

/** Global git flags that take the next word. */
const GIT_WITH_ARG = ['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--super-prefix', '--exec-path']

/** A subcommand's options as git reads them: values taken (`-e -n` is an exclude, not a dry run), long names abbreviated. */
type GitOptions = { short: Set<string>; long: string[]; values: [string, string][]; operands: Word[]; afterDashes: Word[] | null }

const gitOptions = (rest: Word[], shortWithValue = '', longWithValue: string[] = []): GitOptions => {
  const o: GitOptions = { short: new Set(), long: [], values: [], operands: [], afterDashes: null }
  const longs = [...longWithValue, '--pathspec-from-file']
  for (let i = 0; i < rest.length; i++) {
    const w = rest[i]!
    if (w.text === '--') {
      o.afterDashes = rest.slice(i + 1)
      break
    }
    if (w.text.startsWith('--')) {
      const [flag, glued] = splitFlag(w)
      const full = longs.find(l => flag.length >= 4 && l.startsWith(flag))
      if (full === undefined) o.long.push(flag)
      else o.values.push([full, glued?.text ?? rest[++i]?.text ?? ''])
      continue
    }
    if (/^-[a-zA-Z]/.test(w.text)) {
      for (let k = 1; k < w.text.length; k++) {
        const c = w.text[k]!
        if (!shortWithValue.includes(c)) {
          o.short.add(c)
          continue
        }
        o.values.push([`-${c}`, k + 1 < w.text.length ? w.text.slice(k + 1) : (rest[++i]?.text ?? '')])
        break
      }
      continue
    }
    o.operands.push(w)
  }
  return o
}

/** True when the options name `full`, written out or abbreviated as git allows (`--dry` for `--dry-run`). */
const hasLong = (o: GitOptions, full: string) => o.long.some(l => l.length >= 4 && full.startsWith(l))

/**
 * `git rm`, `git clean` and the commands that throw away uncommitted changes.
 * A dry run never takes the command's own `-c` or other global flags (a config
 * value such as `core.fsmonitor` would run code before anyone answered), and
 * never runs against a repository named by `--git-dir`/`--work-tree`.
 */
const readGit = (args: Word[], ctx: Ctx, hasGitEnv: boolean): Found | null => {
  const cwd = [...ctx.cwd]
  let isCwdKnown = ctx.isCwdKnown
  let isUnlistable = hasGitEnv
  let i = 0
  while (i < args.length && isFlag(args[i]!)) {
    const [flag, glued] = splitFlag(args[i]!)
    const value = GIT_WITH_ARG.includes(flag) && flag !== '--exec-path' ? (glued ?? args[++i]) : undefined
    if (flag === '-C') {
      if (value === undefined || value.isDynamic) isCwdKnown = false
      else cwd.push(value.text)
    } else if (flag === '--git-dir' || flag === '--work-tree') isUnlistable = true
    i++
  }
  const sub = args[i]?.text
  const rest = args.slice(i + 1)
  const text = ['git', ...args.map(w => w.text)].join(' ')
  const git = ['git', '-c', 'core.fsmonitor=false', '--no-optional-locks']
  const rootArgv = [...git, 'rev-parse', '--show-toplevel']
  const opaque = (why: string): Found => ({ kind: 'opaque', text, why })

  if (sub === 'rm') {
    const o = gitOptions(rest)
    if (o.values.some(([name]) => name === '--pathspec-from-file')) return opaque('removes the paths listed in a file')
    if (o.short.has('n') || hasLong(o, '--dry-run') || hasLong(o, '--cached')) return null
    const words = [...o.operands, ...(o.afterDashes ?? [])]
    return words.length === 0 ? null : { kind: 'paths', tool: 'git rm', cwd, isCwdKnown, words }
  }
  if (sub === 'clean') {
    const o = gitOptions(rest, 'e', ['--exclude'])
    if (o.short.has('n') || hasLong(o, '--dry-run')) return null
    const paths = [...o.operands, ...(o.afterDashes ?? [])]
    if (isUnlistable || args.some(w => w.isDynamic)) return { kind: 'git-clean', cwd, isCwdKnown, argv: null, rootArgv, text }
    // only the flags that change what is listed; anything else (`--interactive`, abbreviated or not) stays out
    const flags = [
      ...['d', 'x', 'X'].filter(c => o.short.has(c)).map(c => `-${c}`),
      ...o.values.filter(([name]) => name === '-e' || name === '--exclude').map(([, v]) => `--exclude=${v}`),
    ]
    return { kind: 'git-clean', cwd, isCwdKnown, argv: [...git, 'clean', '-n', ...flags, '--', ...paths.map(w => w.text)], rootArgv, text }
  }
  if (sub === 'stash' && (rest[0]?.text === 'drop' || rest[0]?.text === 'clear')) return opaque('throws away stashed changes')
  if (sub === 'worktree' && rest[0]?.text === 'remove' && rest.some(w => w.text === '-f' || w.text === '--force'))
    return opaque('removes a worktree together with its uncommitted changes')

  const discard = (paths: Word[], scope: 'worktree' | 'all', note?: string): Found => ({
    kind: 'git-discard',
    cwd,
    isCwdKnown,
    scope,
    text,
    ...(note === undefined ? {} : { note }),
    argv:
      isUnlistable || paths.some(w => w.isDynamic)
        ? null
        : [...git, 'status', '--porcelain=v1', '-z', '--untracked-files=no', '--', ...paths.map(w => w.text)],
    rootArgv,
  })
  if (sub === 'reset') {
    const o = gitOptions(rest)
    if (!hasLong(o, '--hard')) return null
    const rev = o.operands[0]
    return discard(
      [],
      'all',
      rev === undefined || rev.text === 'HEAD' ? undefined : `moves the branch to ${rev.text}: commits after it stay reachable only through the reflog`,
    )
  }
  if (sub === 'restore') {
    const o = gitOptions(rest, 's', ['--source'])
    if (o.values.some(([name]) => name === '--pathspec-from-file')) return opaque('restores the paths listed in a file')
    const isStaged = o.short.has('S') || hasLong(o, '--staged')
    const isWorktree = o.short.has('W') || hasLong(o, '--worktree')
    if (isStaged && !isWorktree) return null
    const hasSource = o.values.some(([name]) => name === '-s' || name === '--source')
    const paths = [...o.operands, ...(o.afterDashes ?? [])]
    return paths.length === 0 ? null : discard(paths, isStaged || hasSource ? 'all' : 'worktree')
  }
  if (sub === 'checkout') {
    const o = gitOptions(rest, 'bB', ['--orphan', '--conflict'])
    if (o.values.some(([name]) => name === '--pathspec-from-file')) return opaque('restores the paths listed in a file')
    const isForce = o.short.has('f') || hasLong(o, '--force')
    if (o.afterDashes !== null) return o.afterDashes.length === 0 ? null : discard(o.afterDashes, o.operands.length > 0 ? 'all' : 'worktree')
    if (isForce) return discard([], 'all')
    // `git checkout name`: a file of that name loses its changes; a branch name lists nothing and is not asked about
    if (o.operands.length > 0 && !o.values.some(([name]) => /^-[bB]$|^--orphan$/.test(name)))
      return discard(o.operands, o.operands.length > 1 ? 'all' : 'worktree')
    return null
  }
  if (sub === 'switch') {
    const o = gitOptions(rest, 'cC', ['--create', '--force-create', '--orphan'])
    return o.short.has('f') || hasLong(o, '--force') || hasLong(o, '--discard-changes') ? discard([], 'all') : null
  }
  return null
}

/**
 * `truncate` keeps the file but cuts its content: what it does to each file, as
 * `change`. Only growing it (`+N`, `>N`, `%N`) loses nothing and is left alone.
 */
const readTruncate = (args: Word[], ctx: Ctx): Found | null => {
  let size: string | undefined
  let ref: string | undefined
  const words: Word[] = []
  let isFlagsDone = false
  for (let i = 0; i < args.length; i++) {
    const w = args[i]!
    const t = w.text
    if (isFlagsDone || !isFlag(w)) words.push(w)
    else if (t === '--') isFlagsDone = true
    else if (t === '--size' || t === '--reference' || /^-[a-z]*[sr]$/.test(t)) {
      const value = args[++i]?.text ?? ''
      if (t === '--size' || t.endsWith('s')) size = value
      else ref = value
    } else if (t.startsWith('--size=')) size = t.slice(7)
    else if (t.startsWith('--reference=')) ref = t.slice(12)
    else {
      const glued = /^-[a-z]*?([sr])(.+)$/.exec(t)
      if (glued?.[1] === 's') size = glued[2]
      else if (glued?.[1] === 'r') ref = glued[2]
    }
  }
  if (words.length === 0 || (size === undefined && ref === undefined)) return null
  if (size !== undefined && /^[+>%]/.test(size)) return null
  const change =
    size === undefined
      ? `size set to that of ${ref}`
      : /^0+$/.test(size)
        ? 'emptied, the file stays'
        : size.startsWith('-')
          ? `shortened by ${size.slice(1)}`
          : size.startsWith('<')
            ? `cut to at most ${size.slice(1)}`
            : size.startsWith('/')
              ? `cut to a multiple of ${size.slice(1)}`
              : `size set to ${size}`
  return { kind: 'paths', tool: 'truncate', cwd: [...ctx.cwd], isCwdKnown: ctx.isCwdKnown, words, change }
}

/** Flags of `cp`, `mv` and `install` that take a value; the short ones may end a group (`-rt dir`). */
const COPY_WITH_ARG: Record<string, string[]> = {
  cp: ['-t', '--target-directory', '-S', '--suffix'],
  mv: ['-t', '--target-directory', '-S', '--suffix'],
  install: ['-t', '--target-directory', '-S', '--suffix', '-m', '--mode', '-o', '--owner', '-g', '--group', '--strip-program'],
  ln: ['-t', '--target-directory', '-S', '--suffix'],
}

/** `cp`, `mv`, `install`, `ln -f`: the file or folder they write to. Not when they keep what is there (`-n`, `-i`, `-b`). */
const readCopy = (name: string, args: Word[], ctx: Ctx): Found | null => {
  const withArg = COPY_WITH_ARG[name]!
  const keeps = name === 'install' ? /[bd]/ : name === 'ln' ? /[ib]/ : /[nib]/
  // `ln` replaces an existing name only with -f
  if (name === 'ln' && !args.some(w => w.text === '--force' || /^-[a-zA-Z]*f/.test(w.text))) return null
  const files: Word[] = []
  let target: Word | undefined
  let isNoTarget = false
  let isFlagsDone = false
  for (let i = 0; i < args.length; i++) {
    const w = args[i]!
    if (isFlagsDone || !isFlag(w)) {
      files.push(w)
      continue
    }
    if (w.text === '--') {
      isFlagsDone = true
      continue
    }
    const [flag, glued] = splitFlag(w)
    if (['--no-clobber', '--interactive', '--backup', '--directory'].includes(flag) || (flag === '--update' && glued?.text.startsWith('none')))
      return null
    if (flag === '--no-target-directory') isNoTarget = true
    if (flag.startsWith('--')) {
      if (withArg.includes(flag)) {
        const value = glued ?? args[++i]
        if (flag === '--target-directory') target = value
      }
      continue
    }
    const letters = flag.slice(1)
    if (keeps.test(letters)) return null
    if (letters.includes('T')) isNoTarget = true
    const last = `-${letters.at(-1)}`
    if (withArg.includes(last)) {
      const value = args[++i]
      if (last === '-t') target = value
    }
  }
  const dest = target ?? (files.length >= 2 ? files.pop() : undefined)
  if (dest === undefined) return null
  return {
    kind: 'overwrite',
    tool: name,
    cwd: [...ctx.cwd],
    isCwdKnown: ctx.isCwdKnown,
    dest,
    sources: files,
    intoDir: isNoTarget ? false : target !== undefined || files.length > 1 ? true : null,
    isOnlyNonEmpty: false,
  }
}

type Ctx = { cwd: string[]; isCwdKnown: boolean; found: Found[]; others: number; depth: number }

/** A file the command writes from the start: asked about only if it holds something now. */
const overwrite = (tool: string, dest: Word, ctx: Ctx, isOnlyNonEmpty = true): Found => ({
  kind: 'overwrite',
  tool,
  cwd: [...ctx.cwd],
  isCwdKnown: ctx.isCwdKnown,
  dest,
  sources: [],
  intoDir: false,
  isOnlyNonEmpty,
})

/** One simple command: what it deletes goes to `ctx.found`, a `cd` moves `ctx.cwd`. */
const readCommand = (raw: Word[], ctx: Ctx) => {
  const { words, chdir, isPlain } = unwrap(raw)
  if (!isPlain) ctx.others++
  if (words.length === 0) {
    if (raw.some(w => !KEYWORDS.has(w.text))) ctx.others++
    return
  }
  if (chdir.length === 0) return readSimple(words, ctx, raw)
  const saved = { cwd: ctx.cwd, isCwdKnown: ctx.isCwdKnown }
  for (const dir of chdir) {
    if (dir.isDynamic) ctx.isCwdKnown = false
    else ctx.cwd = [...ctx.cwd, dir.text]
  }
  try {
    readSimple(words, ctx, raw)
  } finally {
    ctx.cwd = saved.cwd
    ctx.isCwdKnown = saved.isCwdKnown
  }
}

const readSimple = (words: Word[], ctx: Ctx, raw: Word[]) => {
  const head = words[0]!
  const name = baseName(head.text)
  const args = words.slice(1)
  const text = words.map(w => w.text).join(' ')
  if (head.isDynamic) {
    ctx.others++
    return
  }
  // `./rm` is read as rm, but it is some other program: never only a delete
  if (!isSystemPath(head.text)) ctx.others++

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
  if (name === 'trash-empty' || name === 'trash-rm' || (name === 'gio' && args[0]?.text === 'trash' && args.some(w => w.text === '--empty'))) {
    ctx.found.push({ kind: 'opaque', text, why: name === 'trash-rm' ? 'removes matching files from the trash for good' : 'empties the trash for good' })
    return
  }
  if (name === 'gio' && (args[0]?.text === 'trash' || args[0]?.text === 'remove')) {
    const words = operands(args.slice(1))
    if (words.length > 0) ctx.found.push({ kind: 'paths', tool: `gio ${args[0]!.text}`, cwd: [...ctx.cwd], isCwdKnown: ctx.isCwdKnown, words })
    return
  }
  if (name === 'truncate') {
    const found = readTruncate(args, ctx)
    if (found !== null) ctx.found.push(found)
    else ctx.others++
    return
  }
  if (name === 'find') {
    const found = readFind(args, ctx)
    if (found !== null) ctx.found.push(...found.found)
    if (found === null || !found.isOnlyDeletes) ctx.others++
    return
  }
  if (name === 'git') {
    const found = readGit(args, ctx, raw.some(w => /^GIT_[A-Z_]*=/.test(w.text)))
    if (found !== null) ctx.found.push(found)
    // `git -c core.fsmonitor=… clean` runs that code: only `-C dir` keeps it a plain delete
    const isPlainGit = (() => {
      for (let i = 0; i < args.length && isFlag(args[i]!); i++) if (args[i]!.text !== '-C' || ++i >= args.length) return false
      return true
    })()
    if (found === null || !isDelete(found) || !isPlainGit) ctx.others++
    return
  }
  if (name === 'cp' || name === 'mv' || name === 'install' || name === 'ln') {
    const found = readCopy(name, args, ctx)
    if (found !== null) ctx.found.push(found)
    ctx.others++
    return
  }
  if (name === 'tee') {
    if (!args.some(w => w.text === '--append' || /^-[a-zA-Z]*a/.test(w.text)))
      for (const w of operands(args)) ctx.found.push(overwrite('tee', w, ctx))
    ctx.others++
    return
  }
  if (name === 'dd') {
    const of = args.find(w => w.text.startsWith('of='))
    if (of !== undefined) {
      const dest: Word = { ...of, text: of.text.slice(3), pattern: of.pattern.slice(3) }
      if (dest.text.startsWith('/dev/') && !/^\/dev\/(null|zero|stdout|stderr|fd\/)/.test(dest.text))
        ctx.found.push({ kind: 'opaque', text, why: `writes straight to the device ${dest.text}` })
      else ctx.found.push(overwrite('dd', dest, ctx, false))
    }
    ctx.others++
    return
  }
  if (name === 'xargs') {
    let i = 0
    const withArg = ['-I', '-n', '-P', '-L', '-d', '-s', '-a', '-E', '-J', '-R', '-S']
    const longWithArg = ['--max-args', '--max-procs', '--max-lines', '--delimiter', '--max-chars', '--arg-file', '--eof', '--process-slot-var']
    while (i < args.length && isFlag(args[i]!)) {
      const t = args[i]!.text
      if (t === '--') {
        i++
        break
      }
      i += withArg.includes(t) || longWithArg.includes(t) ? 2 : 1
    }
    const stand: Word = { text: '{}', pattern: '{}', isDynamic: true }
    const sub = subCommand([...args.slice(i), stand], ctx)
    if (sub.found.some(isDelete)) {
      ctx.found.push({ kind: 'opaque', text, why: 'deletes whatever the command before it lists' }, ...strip(sub.found, stand))
    } else ctx.others++
    return
  }
  if (name === 'rsync') {
    if (args.some(w => /^--(del|delete(-[a-z]+)?|remove-(source|sent)-files)(=|$)/.test(w.text)))
      ctx.found.push({ kind: 'opaque', text, why: 'removes files at the destination that the source lacks' })
    ctx.others++
    return
  }
  if ((SHELLS.has(name) || name === 'eval') && ctx.depth < 4) {
    const { script, isPlain } = name === 'eval' ? { script: args.map(w => w.text).join(' '), isPlain: true } : shellScript(args)
    if (script !== undefined) {
      const sub = analyze(script, { ...ctx, cwd: [...ctx.cwd], found: [], others: 0, depth: ctx.depth + 1 })
      ctx.found.push(...sub.found)
      if (!sub.isOnlyDeletes || !isPlain) ctx.others++
      return
    }
  }
  if (!SAFE_EXTRA.has(name)) ctx.others++
}

/** The script of `bash -c '...'`: `c` may sit in any flag group (`-lc`, `-cf`), `--` may come first. */
const shellScript = (args: Word[]): { script: string | undefined; isPlain: boolean } => {
  let hasC = false
  // a login or interactive shell, or another rc file, runs more than the script
  let isPlain = true
  let i = 0
  for (; i < args.length; i++) {
    const t = args[i]!.text
    if (t === '--' || t === '-') {
      i++
      break
    }
    if (/^[-+][a-zA-Z]+$/.test(t)) {
      if (t.startsWith('-') && t.includes('c')) hasC = true
      if (!/^[-+][ceuxvo]+$/.test(t)) isPlain = false
      if (/[oO]$/.test(t) && !['pipefail', 'errexit', 'nounset', 'xtrace'].includes(args[++i]?.text ?? '')) isPlain = false
    } else if (t.startsWith('--')) {
      isPlain = false
      if (t === '--rcfile' || t === '--init-file') i++
    } else break
  }
  return { script: hasC ? args[i]?.text : undefined, isPlain }
}

const analyze = (command: string, ctx: Ctx): Analysis => {
  const { tokens, inner } = lex(command)
  const stack: { cwd: string[]; isCwdKnown: boolean }[] = []
  let words: Word[] = []
  let redirect: Redirect | null = null
  let hasRedirect = false
  const end = () => {
    readCommand(words, ctx)
    words = []
  }
  for (const t of tokens) {
    if (t.type === 'word') {
      // `> file` (and `>& file`, not `2>&1`) empties the file before anything runs
      if (redirect === 'write' || (redirect === 'dup' && !/^(\d+|-)$/.test(t.word.text))) ctx.found.push(overwrite('>', t.word, ctx))
      if (redirect !== null) redirect = null
      else words.push(t.word)
      continue
    }
    if (t.type === 'redirect') {
      redirect = t.mode
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
  return { found: ctx.found, isOnlyDeletes: ctx.others === 0 && !hasRedirect && ctx.found.every(f => f.kind !== 'opaque' && isDelete(f)) }
}

/** What the command would delete or overwrite, and whether deleting is all it does. */
export const findDeletes = (command: string): Analysis =>
  analyze(command, { cwd: [], isCwdKnown: true, found: [], others: 0, depth: 0 })

/** More names than this from one word are not listed: the word counts as unknown. */
const MAX_NAMES = 1000

/** Expands `{a,b}` and `{1..3}` in an escaped pattern, as bash does before globbing; `null` past `MAX_NAMES`. */
export const expandBraces = (pattern: string): string[] | null => {
  try {
    return braces(pattern)
  } catch {
    return null
  }
}

const braces = (pattern: string): string[] => {
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
      const range = /^(-?\d+|[a-zA-Z])\.\.(-?\d+|[a-zA-Z])(?:\.\.(-?\d+))?$/.exec(body)
      const isLetters = range !== null && /^[a-zA-Z]$/.test(range[1]!) && /^[a-zA-Z]$/.test(range[2]!)
      const parts: string[] = []
      if (range !== null && (isLetters || (/\d/.test(range[1]!) && /\d/.test(range[2]!)))) {
        const [a, b] = isLetters ? [range[1]!.charCodeAt(0), range[2]!.charCodeAt(0)] : [Number(range[1]), Number(range[2])]
        const step = Math.max(1, Math.abs(Number(range[3] ?? 1)))
        if (Math.abs(b - a) / step >= MAX_NAMES) throw new RangeError('too many names')
        // `{01..10}` pads to the wider end, as bash does
        const width = !isLetters && (/^-?0\d/.test(range[1]!) || /^-?0\d/.test(range[2]!)) ? Math.max(range[1]!.length, range[2]!.length) : 0
        const show = (n: number) =>
          isLetters ? String.fromCharCode(n) : n < 0 ? `-${String(-n).padStart(width - 1, '0')}` : String(n).padStart(width, '0')
        for (let n = a; a <= b ? n <= b : n >= b; n += a <= b ? step : -step) parts.push(show(n))
      } else if (range !== null) {
        // `{a..3}` is not a range to bash: the word stays as it is
        return braces(post).map(p => `${pre}{${body}}${p}`)
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
        if (parts.length === 0) return braces(post).map(p => `${pre}{${body}}${p}`)
        parts.push(body.slice(from))
      }
      const out = parts.flatMap(part => braces(pre + part + post))
      if (out.length > MAX_NAMES) throw new RangeError('too many names')
      return out
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
