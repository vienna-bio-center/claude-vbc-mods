import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Entry, Request } from '../types'
import {
  bytes,
  expandBraces,
  findDeletes,
  hasGlob,
  joinPath,
  segmentRegex,
  showPath,
  tilde,
  unescape,
} from './parse'
import type { Found } from './parse'

type $ = EngineInterface
type Answer = 'allow' | 'cancel'

const PANE = 'delete-guard'
const TITLE = 'Delete Guard'
const queue = atom({ plugin: 'delete-guard', key: 'queue' } as const, [])

/** Entries listed per command, folder entries counted per folder, paths shown inside a folder. */
const MAX_ENTRIES = 300
const WALK_LIMIT = 5000
const SAMPLE = 5

// The hooks waiting for an answer, by request id. A reload starts it empty and
// `session.start` clears the queue to match.
const waiting = new Map<string, (answer: Answer) => void>()
// Calls the person allowed that delete and nothing else: the engine's own
// "allow this command?" question is answered for them (see `tool.check`).
const approved = new Set<string>()

const blank = (path: string): Entry => ({
  path,
  kind: 'missing',
  size: 0,
  files: 0,
  dirs: 0,
  isPartial: false,
  sample: [],
  note: '',
})

/** Counts what lies under a folder, breadth first, so the sample shows its top level. */
const walk = async ($: $, root: string) => {
  let files = 0
  let dirs = 0
  let size = 0
  let seen = 0
  const sample: string[] = []
  const todo = ['']
  while (todo.length > 0) {
    const rel = todo.shift()!
    const list = await $.fs.list(rel === '' ? root : `${root}/${rel}`).catch(() => [])
    for (const entry of [...list].sort((a, b) => a.name.localeCompare(b.name))) {
      const path = rel === '' ? entry.name : `${rel}/${entry.name}`
      if (++seen > WALK_LIMIT) return { files, dirs, size, sample, isPartial: true }
      if (entry.kind === 'dir') {
        dirs++
        todo.push(path)
      } else {
        files++
        size += entry.size
      }
      if (sample.length < SAMPLE) sample.push(entry.kind === 'dir' ? `${path}/` : path)
    }
  }
  return { files, dirs, size, sample, isPartial: false }
}

const describe = async ($: $, abs: string, cwd: string, home: string, isDeep: boolean): Promise<Entry> => {
  const entry = blank(showPath(abs, cwd, home))
  const stat = await $.fs.stat(abs).catch(() => undefined)
  if (stat === undefined) return { ...entry, note: 'does not exist' }
  if (stat.isLink) return { ...entry, kind: 'link', note: 'a link: only the link goes, not what it points to' }
  if (stat.kind === 'dir') return { ...entry, kind: 'dir', ...(isDeep ? await walk($, abs) : {}) }
  return { ...entry, kind: 'file', size: stat.size }
}

/** The paths a shell word names: `~`, braces and globs expanded as bash would; `null` for none, `too-many` past the limit. */
const expand = async ($: $, pattern: string, base: string, home: string): Promise<string[] | null | 'too-many'> => {
  const out: string[] = []
  const names = expandBraces(pattern)
  if (names === null) return 'too-many'
  for (let p of names) {
    if (p === '~' || p.startsWith('~/')) p = home.replace(/[\\*?[\]{}~]/g, '\\$&') + p.slice(1)
    if (!hasGlob(p)) {
      out.push(joinPath(base, unescape(p)))
      continue
    }
    const segments = p.split('/').filter(s => s !== '')
    let found = [p.startsWith('/') ? '/' : base]
    for (const segment of segments) {
      if (!hasGlob(segment)) {
        found = found.map(d => joinPath(d, unescape(segment)))
        continue
      }
      const re = segmentRegex(segment)
      const next: string[] = []
      for (const dir of found) {
        const list = await $.fs.list(dir).catch(() => [])
        for (const entry of list) if (re.test(entry.name)) next.push(joinPath(dir, entry.name))
      }
      found = next.sort()
    }
    const exists = await Promise.all(found.map(f => $.fs.exists(f).catch(() => false)))
    out.push(...found.filter((_, i) => exists[i]))
  }
  return out.length > 0 ? out : null
}

/** Folders where overwriting a file is never asked about: scratch space and devices. */
const scratch = async ($: $) => {
  const tmp = ((await $.env.get('TMPDIR')) ?? '').replace(/\/+$/, '')
  return ['/tmp', '/private/tmp', '/dev', ...(tmp === '' ? [] : [tmp, `/private${tmp}`])]
}

/** Parts that are asked about even when nothing they name exists right now. */
export const isAlwaysAsked = (f: Found) => (f.kind === 'overwrite' ? false : f.kind === 'git-discard' ? f.note !== undefined : true)

const baseName = (s: string) => s.slice(s.lastIndexOf('/') + 1)

/** Lists everything the found parts of a command would delete, cut, overwrite or throw away. */
export const resolve = async ($: $, found: Found[], cwd: string, home: string) => {
  const entries: Entry[] = []
  const notes: string[] = []
  const seen = new Set<string>()
  const skip = await scratch($)
  const isScratch = (abs: string) => skip.some(d => abs === d || abs.startsWith(`${d}/`))
  let skipped = 0
  const add = async (abs: string, isDeep: boolean, extra: Pick<Entry, 'action' | 'change'> = {}) => {
    if (seen.has(abs)) return
    seen.add(abs)
    if (entries.length >= MAX_ENTRIES) skipped++
    else entries.push({ ...(await describe($, abs, cwd, home, isDeep)), ...extra })
  }
  /** The folder a part runs in; `null` with the reason when that can't be known beforehand. */
  const dirOf = async (f: { cwd: string[]; isCwdKnown: boolean }): Promise<{ dir: string | null; why: string }> => {
    if (!f.isCwdKnown) return { dir: null, why: 'folder unknown: the command changes folder first' }
    const dir = f.cwd.reduce((d, seg) => joinPath(d, seg === '~' || seg.startsWith('~/') ? home + seg.slice(1) : seg), cwd)
    if (f.cwd.length > 0 && !(await $.fs.exists(dir).catch(() => false)))
      return { dir: null, why: `folder unknown: ${tilde(dir, home)} does not exist now` }
    return { dir, why: '' }
  }
  const isRelative = (w: { text: string; pattern: string }) => !w.text.startsWith('/') && !w.pattern.startsWith('~')
  // a git dry run only in the session's own repository: another one's config (a planted filter) would run before anyone answered
  const tops = new Map<string, Promise<string | null>>()
  const topOf = (dir: string, argv: string[]) => {
    if (!tops.has(dir))
      tops.set(
        dir,
        $.process.run(argv, { cwd: dir, timeoutMs: 15_000 }).then(
          r => (r.exitCode === 0 ? r.stdout.trim() : null),
          () => null,
        ),
      )
    return tops.get(dir)!
  }
  const isOwnRepo = async (dir: string, argv: string[]) => {
    const [top, own] = await Promise.all([topOf(dir, argv), topOf(cwd, argv)])
    return top !== null && top === own
  }

  for (const f of found) {
    if (f.kind === 'opaque') {
      notes.push(`${f.text}: ${f.why}, so it can't be listed beforehand`)
      continue
    }
    const { dir, why } = await dirOf(f)
    if (f.kind === 'paths') {
      const extra: Pick<Entry, 'action' | 'change'> = f.change === undefined ? {} : { action: 'truncate', change: f.change }
      for (const word of f.words) {
        if (word.isDynamic || (dir === null && isRelative(word))) {
          entries.push({ ...blank(word.text), ...extra, kind: 'unknown', note: word.isDynamic ? 'decided only when the command runs' : why })
          continue
        }
        const paths = await expand($, word.pattern, dir ?? cwd, home)
        if (paths === 'too-many') entries.push({ ...blank(word.text), ...extra, kind: 'unknown', note: 'too many names to list' })
        else if (paths === null) entries.push({ ...blank(word.text), ...extra, note: 'matches nothing' })
        else for (const p of paths) await add(p, f.change === undefined, extra)
      }
      continue
    }
    if (f.kind === 'overwrite') {
      // only what exists now is at stake; a name known only when it runs is not asked about
      if (f.dest.isDynamic || (dir === null && isRelative(f.dest))) continue
      const dests = await expand($, f.dest.pattern, dir ?? cwd, home)
      const change = { action: 'overwrite' as const, change: `overwritten by ${f.tool === '>' ? 'a > redirect' : f.tool}` }
      for (const dest of Array.isArray(dests) ? dests : []) {
        if (isScratch(dest)) continue
        const stat = await $.fs.stat(dest).catch(() => undefined)
        if (stat === undefined) continue
        const isInto = f.intoDir ?? stat.kind === 'dir'
        if (!isInto) {
          if (stat.kind === 'file' && !(f.isOnlyNonEmpty && stat.size === 0)) await add(dest, false, change)
          continue
        }
        if (stat.kind !== 'dir') continue
        for (const source of f.sources) {
          if (source.isDynamic || (dir === null && isRelative(source))) continue
          const names = await expand($, source.pattern, dir ?? cwd, home)
          for (const name of Array.isArray(names) ? names : []) {
            // `cp -r src/ dest` copies what is inside src on macOS, src itself on Linux: check both
            const inside = /\/\.?$/.test(source.text) ? (await $.fs.list(name).catch(() => [])).map(e => joinPath(dest, e.name)) : []
            for (const target of [joinPath(dest, baseName(name)), ...inside]) {
              if (isScratch(target) || !(await $.fs.exists(target).catch(() => false))) continue
              await add(target, false, change)
            }
          }
        }
      }
      continue
    }
    if (f.kind === 'git-discard') {
      if (f.note !== undefined) notes.push(`${f.text}: ${f.note}`)
      if (f.argv === null || dir === null) {
        notes.push(`${f.text}: its changed files can't be listed beforehand`)
        continue
      }
      if (!(await isOwnRepo(dir, f.rootArgv))) {
        notes.push(`${f.text}: works outside this session's repository, so its changed files are not listed beforehand`)
        continue
      }
      const top = (await topOf(dir, f.rootArgv))!
      const ran = await $.process.run(f.argv, { cwd: dir, timeoutMs: 15_000 }).catch(() => undefined)
      if (ran === undefined || ran.exitCode !== 0) {
        notes.push(`${f.text}: listing its changed files beforehand failed`)
        continue
      }
      const fields = ran.stdout.split('\0')
      for (let k = 0; k < fields.length; k++) {
        const field = fields[k]!
        if (field.length < 4) continue
        const [x, y] = [field[0]!, field[1]!]
        if (x === 'R' || x === 'C') k++
        // a deleted file comes back: nothing is lost there
        if (f.scope === 'worktree' ? y === ' ' || y === 'D' : /^[ D]{2}$/.test(x + y)) continue
        await add(joinPath(top, field.slice(3)), false, { action: 'discard', change: 'uncommitted changes discarded' })
      }
      continue
    }
    if (f.argv === null || dir === null) {
      notes.push(`${f.text}: can't be listed beforehand`)
      continue
    }
    if (f.kind === 'git-clean' && !(await isOwnRepo(dir, f.rootArgv))) {
      notes.push(`${f.text}: works outside this session's repository, so it is not listed beforehand`)
      continue
    }
    const ran = await $.process.run(f.argv, { cwd: dir, timeoutMs: 15_000 }).catch(() => undefined)
    if (ran === undefined || ran.exitCode !== 0) {
      notes.push(`${f.text}: listing its targets beforehand failed`)
      continue
    }
    const lines = ran.stdout.split('\n').filter(l => l !== '')
    if (f.kind === 'git-clean') {
      for (const line of lines) {
        const path = line.replace(/^Would remove /, '')
        if (path !== line) await add(joinPath(dir, path), path.endsWith('/'))
      }
    } else for (const line of lines) await add(joinPath(dir, line), false)
    if (lines.length === 0) notes.push(`${f.text}: matches nothing right now`)
  }
  if (skipped > 0) notes.push(`and ${skipped} more not listed here`)
  return { entries, notes }
}

/** `1 file`, `3 files`, or `5000+ files` when counting stopped early. */
const plural = (n: number, word: string, isMore = false) =>
  `${n}${isMore ? '+' : ''} ${word}${n === 1 && !isMore ? '' : 's'}`

/** One line for the dialog and the toast: `2 folders (130 files) and 1 file`. */
export const summary = (entries: Entry[], notes: string[] = []) => {
  const dirs = entries.filter(e => e.kind === 'dir')
  const files = entries.filter(e => e.kind === 'file' || e.kind === 'link')
  const unknown = entries.filter(e => e.kind === 'unknown')
  const inside = dirs.reduce((n, d) => n + d.files, 0)
  const parts = [
    dirs.length > 0 &&
      `${plural(dirs.length, 'folder')}${inside > 0 ? ` (${plural(inside, 'file', dirs.some(d => d.isPartial))} inside)` : ''}`,
    files.length > 0 && plural(files.length, 'file'),
    unknown.length > 0 && `${plural(unknown.length, 'path')} known only when it runs`,
  ].filter((p): p is string => p !== false)
  if (parts.length > 0) return parts.join(', ')
  return notes.length > 0 ? "files that can't be listed beforehand" : 'nothing that exists right now'
}

const VERBS = { delete: 'delete', truncate: 'truncate', overwrite: 'overwrite', discard: 'discard changes to' } as const

/** What Claude wants to do, as the dialog says it: `truncate 1 file`, `delete 2 folders`. */
export const headline = (entries: Entry[], notes: string[] = []) => {
  const actions = new Set(entries.map(e => e.action ?? 'delete'))
  const verb = actions.size > 1 ? 'delete or change' : VERBS[[...actions][0] ?? 'delete']
  return `${verb} ${summary(entries, notes)}`
}

type Line = { text: string; color?: string; isDim?: boolean; isBold?: boolean }

/** The panel's list, folders first; each folder with its size and a few paths inside. */
export const lines = (req: Request): Line[] => {
  const out: Line[] = []
  const group = (title: string, kinds: Entry['kind'][], each: (e: Entry) => Line[]) => {
    const list = req.entries.filter(e => kinds.includes(e.kind))
    if (list.length === 0) return
    out.push({ text: `${title} (${list.length})`, isBold: true })
    for (const e of list) out.push(...each(e))
  }
  group('Folders', ['dir'], d => {
    const counts = `${plural(d.files, 'file', d.isPartial)}, ${plural(d.dirs, 'folder', d.isPartial)}, ${bytes(d.size)}`
    const inside = d.sample.map(s => ({ text: `     ${s}`, isDim: true }))
    const more = d.files + d.dirs - d.sample.length
    return [
      { text: `  ▸ ${d.path}/`, color: 'error' },
      { text: `     ${d.files + d.dirs === 0 && !d.isPartial ? 'empty' : counts}`, isDim: true },
      ...inside,
      ...(more > 0 && d.sample.length > 0 ? [{ text: `     … ${more}${d.isPartial ? '+' : ''} more`, isDim: true }] : []),
    ]
  })
  group('Files', ['file', 'link'], f => [
    {
      text: `  • ${f.path}  ${f.kind === 'link' ? '(link)' : bytes(f.size)}${f.change === undefined ? '' : `  → ${f.change}`}`,
      color: 'error',
    },
  ])
  group('Known only when it runs', ['unknown'], u => [{ text: `  ? ${u.path}  ${u.note}`, color: 'warning' }])
  group('Not there (nothing to delete)', ['missing'], m => [{ text: `  ${m.path}  ${m.note}`, isDim: true }])
  if (req.notes.length > 0) {
    out.push({ text: 'Also', isBold: true })
    for (const n of req.notes) out.push({ text: `  ? ${n}`, color: 'warning' })
  }
  return out
}

/** Keeps a list to `room` rows, its last row saying how many it left out. */
export const fit = (all: Line[], room: number): Line[] =>
  all.length <= room ? all : [...all.slice(0, Math.max(1, room - 1)), { text: `… ${all.length - Math.max(1, room - 1)} more lines`, isDim: true }]

/** Answers the request `id`: takes it off the queue and wakes its hook. */
const decide = async ($: $, id: string, answer: Answer) => {
  await update($, queue, list => list.filter(r => r.id !== id))
  waiting.get(id)?.(answer)
  waiting.delete(id)
}

/**
 * Waits for the answer. A hook has 10 seconds of its own time, but time spent
 * inside a `$` call does not count, so a sleeping child process stands in as
 * that call until the person answers. `unheld` when no child can be started.
 */
const hold = async ($: $, decided: Promise<Answer>, signal: AbortSignal): Promise<Answer | 'unheld'> => {
  const isWindows = (await $.env.get('OS')) === 'Windows_NT'
  const argv = isWindows ? ['powershell', '-NoProfile', '-Command', 'Start-Sleep -Seconds 86400'] : ['sleep', '86400']
  const stopped = new Promise<Answer>(done => {
    if (signal.aborted) done('cancel')
    else signal.addEventListener('abort', () => done('cancel'), { once: true })
  })
  const wanted = Promise.race([decided, stopped])
  for (;;) {
    const startedAt = Date.now()
    const child = $.process.spawn({ argv })
    const ended = child.next().then(
      () => 'ended' as const,
      () => 'failed' as const,
    )
    const first = await Promise.race([wanted, ended])
    void child.return(undefined as never).catch(() => undefined)
    if (first === 'failed' || (first === 'ended' && Date.now() - startedAt < 1000)) return 'unheld'
    if (first !== 'ended') return first
  }
}

/** The question in the engine's dialog: what, the command itself, and what can't be listed. */
export const question = (req: Request) => {
  const command = req.command.length > 200 ? `${req.command.slice(0, 200)}…` : req.command
  const also = req.notes
    .slice(0, 3)
    .map(n => ` Note: ${n}.`)
    .join('')
  return `Claude wants to ${headline(req.entries, req.notes)} with \`${command}\`.${also} Allow it?`
}

/** The engine's own question, for when the panel can't be shown or held open. */
const askInstead = async ($: $, req: Request, decided: Promise<Answer>): Promise<Answer> => {
  const asked = $.ui
    .ask(question(req), {
      options: ['Cancel', 'Allow'],
      header: 'Delete Guard',
    })
    .then(
      (a): Answer => (a === 'Allow' ? 'allow' : 'cancel'),
      (): Answer => 'cancel',
    )
  return Promise.race([decided, asked])
}

/** Status line and panel follow the queue. Only for show: a failure here never decides a delete. */
const refresh = async ($: $) => {
  try {
    const list = await read($, queue)
    if (list.length === 0) {
      $.ui.status(undefined)
      await $.ui.close({ id: PANE })
    } else $.ui.status(`${plural(list.length, 'delete')} waiting for your answer`)
  } catch {
    // the answer stands either way
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.state.set({ plugin: 'delete-guard', key: 'queue' } as const, [])
    await $.command.register({
      name: 'delete-guard',
      description: 'Show the panel of deletes waiting for your answer',
    })
    return next(e)
  })

  on('command.run', { command: 'delete-guard' }, async $ => {
    const list = await read($, queue)
    if (list.length === 0) return { text: 'No delete is waiting for an answer.' }
    await $.ui.open({ id: PANE, title: TITLE, focus: true })
    return { text: 'Opened the delete panel.' }
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const { found, isOnlyDeletes } = findDeletes(e.command)
    if (found.length === 0) return next(e)

    const cwd = await $.session.cwd()
    const home = (await $.env.get('HOME')) ?? ''
    const { entries, notes } = await resolve($, found, cwd, home)
    // only overwrites of files that don't exist (or are empty): nothing to lose
    if (!found.some(isAlwaysAsked) && entries.length === 0 && notes.length === 0) return next(e)

    // Nobody to ask (a `claude -p` run): refuse rather than delete unseen.
    if ((await $.session.surfaces()).length === 0)
      return {
        deny: 'delete-guard: deleting or overwriting files needs a person to confirm it, and nobody can be asked in this session.',
      }
    const req: Request = { id: e.tool_use_id, command: e.command, cwd, entries, notes }

    const decided = new Promise<Answer>(done => waiting.set(req.id, done))
    await update($, queue, list => [...list.filter(r => r.id !== req.id), req])
    await refresh($)
    const opened = await $.ui
      .open({ id: PANE, title: TITLE, focus: true })
      .catch(() => ({ isPlaced: false as const, reason: 'the panel could not be opened' }))
    if (opened.isPlaced) $.ui.toast(`Claude wants to ${headline(entries, notes)}: confirm or cancel in the "${TITLE}" panel`)

    let answer: Answer
    try {
      const held = opened.isPlaced ? await hold($, decided, next.signal) : 'unheld'
      answer = held === 'unheld' ? await askInstead($, req, decided) : held
    } finally {
      waiting.delete(req.id)
      await update($, queue, list => list.filter(r => r.id !== req.id))
      await refresh($)
    }

    if (answer === 'cancel')
      return {
        deny:
          'delete-guard: the user cancelled this command, nothing was deleted or overwritten. Do not retry it or change these files another way unless the user asks for it.',
      }
    if (isOnlyDeletes) approved.add(req.id)
    try {
      return await next(e)
    } finally {
      approved.delete(req.id)
    }
  }).catch(($, e, next) =>
    next.called ? next(e) : { deny: 'delete-guard: this command deletes files and could not be checked, so it was blocked.' },
  )

  // Allowed in the panel: the engine's own "run this command?" would ask the
  // same again. Only for a command that does nothing but delete; a settings
  // rule that denies it still wins.
  on('tool.check', { tool: 'Bash' }, async ($, e, next) => {
    const verdict = await next(e)
    return e.tool_use_id !== undefined && approved.has(e.tool_use_id) && verdict.decision === 'ask'
      ? { ...verdict, decision: 'allow' as const, reason: 'confirmed in the delete-guard panel' }
      : verdict
  })

  // Closing the panel by hand cancels everything it was asking about.
  on('ui.close', { id: PANE }, async ($, e, next) => {
    if (e.origin.kind === 'person') for (const r of await read($, queue)) await decide($, r.id, 'cancel')
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const list = await read($, queue)
    const req = list[0]
    if (req === undefined) return <Text dimColor>No delete is waiting for an answer.</Text>

    const home = (await $.env.get('HOME')) ?? ''
    const command = req.command.length > 300 ? `${req.command.slice(0, 300)}…` : req.command
    const room = Math.max(6, e.props.scroll.bodyRows - 10)

    return (
      <Box flexDirection="column">
        <Box flexDirection="column">
          <Text bold color="error">
            {TITLE}
          </Text>
          <Text bold color="error">
            Claude wants to {headline(req.entries, req.notes)}
          </Text>
        </Box>
        {list.length > 1 && <Text color="warning">1 of {list.length} waiting</Text>}
        <Text dimColor wrap="truncate-middle">
          in {tilde(req.cwd, home)}
        </Text>
        <Text dimColor>$ {command}</Text>
        <Text> </Text>
        {fit(lines(req), room).map(line => (
          <Text color={line.color} dimColor={line.isDim} bold={line.isBold} wrap="truncate-middle">
            {line.text}
          </Text>
        ))}
        <Text> </Text>
        <Box flexDirection="row">
          <Button key="cancel" hotkey="n" autoFocus onPress={() => decide($, req.id, 'cancel')}>
            Cancel
          </Button>
          <Text> </Text>
          <Button key="allow" variant="primary" onPress={() => decide($, req.id, 'allow')}>
            Allow
          </Button>
        </Box>
      </Box>
    )
  })
}
