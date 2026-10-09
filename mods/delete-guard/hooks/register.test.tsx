import type { FsEntry, On, RenderSurface } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

import type { Request } from '../types'
import { fit, headline, lines, question, summary } from './register'

const PANE = {
  component: 'Pane',
  requestId: 'delete-guard',
  props: {
    title: 'Delete Guard',
    isFocused: true,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

// A small disk: /p/build holds two files and a folder, /p/notes.txt is a file.
const DIRS: Record<string, FsEntry[]> = {
  '/p': [
    { name: 'build', kind: 'dir', size: 0, mtimeMs: 0, isLink: false },
    { name: 'notes.txt', kind: 'file', size: 2048, mtimeMs: 0, isLink: false },
  ],
  '/p/build': [
    { name: 'app.js', kind: 'file', size: 1000, mtimeMs: 0, isLink: false },
    { name: 'assets', kind: 'dir', size: 0, mtimeMs: 0, isLink: false },
  ],
  '/p/build/assets': [{ name: 'logo.png', kind: 'file', size: 3000, mtimeMs: 0, isLink: false }],
}

/** Answers what the plugin asks of the session, the disk and the host; records the commands that ran. */
const host = (on: On, surfaces: RenderSurface[] = ['terminal']) => {
  const ran: string[] = []
  const clock = mock.clock(on)
  mock.env(on, { HOME: '/home/u' })
  on('session.surfaces', () => ({ value: surfaces }))
  on('session.cwd', () => ({ value: '/p' }))
  on('fs.list', (_$, e) => ({ value: DIRS[e.path ?? '/p'] ?? [] }))
  on('fs.exists', (_$, e) => ({ value: e.path in DIRS || e.path === '/p/notes.txt' }))
  on('fs.stat', (_$, e) => {
    if (e.path in DIRS) return { value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false } }
    if (e.path === '/p/notes.txt') return { value: { kind: 'file', size: 2048, mtimeMs: 0, isLink: false } }
    throw new Error('ENOENT')
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  // the sleeping child that holds the call open: never ends on its own
  on('process.spawn', async function* () {
    await new Promise(() => undefined)
  })
  // git in /p: notes.txt has uncommitted changes, gone.txt was deleted
  on('process.run', (_$, e) => {
    const argv = e.argv.join(' ')
    if (argv.includes('rev-parse --show-toplevel')) return { value: { exitCode: 0, stdout: '/p\n', stderr: '', isStdoutTruncated: false } as never }
    if (argv.includes(' status ')) return { value: { exitCode: 0, stdout: ' M notes.txt\0 D gone.txt\0', stderr: '', isStdoutTruncated: false } as never }
    return { value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false } as never }
  })
  on('tool.call', (_$, e) => {
    if (e.tool === 'Bash') ran.push(e.command)
    return { result: { stdout: '', stderr: '', interrupted: false } as never }
  })
  return { ran, clock }
}

describe('panel text', () => {
  const REQ: Request = {
    id: 't1',
    command: 'rm -rf build notes.txt',
    cwd: '/p',
    notes: [],
    entries: [
      { path: 'build', kind: 'dir', size: 4000, files: 2, dirs: 1, isPartial: false, sample: ['app.js', 'assets/', 'assets/logo.png'], note: '' },
      { path: 'notes.txt', kind: 'file', size: 2048, files: 0, dirs: 0, isPartial: false, sample: [], note: '' },
      { path: 'gone', kind: 'missing', size: 0, files: 0, dirs: 0, isPartial: false, sample: [], note: 'does not exist' },
    ],
  }

  test('summary counts folders, files and what is inside', async () => {
    expect(summary(REQ.entries)).toBe('1 folder (2 files inside), 1 file')
    expect(summary([])).toBe('nothing that exists right now')
  })

  test('lines list folders first, then files, then what is not there', async () => {
    const text = lines(REQ).map(l => l.text)
    expect(text[0]).toBe('Folders (1)')
    expect(text).toContain('  ▸ build/')
    expect(text).toContain('     2 files, 1 folder, 4 KB')
    expect(text).toContain('  • notes.txt  2 KB')
    expect(text.indexOf('Files (1)')).toBeGreaterThan(text.indexOf('Folders (1)'))
    expect(text.at(-1)).toBe('  gone  does not exist')
  })

  test('a truncated file says what happens to it, and the headline says truncate', async () => {
    const cut = { ...REQ.entries[1]!, action: 'truncate' as const, change: 'emptied, the file stays' }
    expect(lines({ ...REQ, entries: [cut] }).map(l => l.text)).toContain('  • notes.txt  2 KB  → emptied, the file stays')
    expect(headline([cut])).toBe('truncate 1 file')
    expect(headline([cut, REQ.entries[0]!])).toBe('delete or change 1 folder (2 files inside), 1 file')
  })

  test('with nothing listable the text says so, and the question carries the command and notes', async () => {
    const req: Request = { id: 't2', command: 'find . -name x | xargs rm', cwd: '/p', entries: [], notes: ['xargs rm: deletes whatever the command before it lists'] }
    expect(headline(req.entries, req.notes)).toBe("delete files that can't be listed beforehand")
    expect(question(req)).toBe(
      "Claude wants to delete files that can't be listed beforehand with `find . -name x | xargs rm`. Note: xargs rm: deletes whatever the command before it lists. Allow it?",
    )
  })

  test('fit keeps to the room and says how much it left out', async () => {
    const all = lines(REQ)
    expect(fit(all, 100)).toEqual(all)
    const cut = fit(all, 4)
    expect(cut.length).toBe(4)
    expect(cut.at(-1)?.text).toBe(`… ${all.length - 3} more lines`)
  })
})

describe('asking before a delete', () => {
  test('a command that deletes nothing runs without a question', async ($, on) => {
    const { ran } = host(on)
    await $.tool.call({ tool: 'Bash', command: 'ls -la' })
    expect(ran).toEqual(['ls -la'])
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    test(`Allow lets the delete run (${surface})`, async ($, on) => {
      const { ran, clock } = host(on, [surface])
      const call = $.tool.call({ tool: 'Bash', command: 'rm -rf build notes.txt' })
      await clock.settle()
      expect(ran).toEqual([])

      const pane = await $.ui.mount({ plugin: 'delete-guard', surface, ...PANE })
      expect(await pane.find({ type: 'Text', text: /1 folder \(2 files inside\), 1 file/ })).toBeDefined()
      expect(await pane.find({ type: 'Text', text: /build\// })).toBeDefined()
      expect(await pane.find({ type: 'Text', text: /assets\/logo\.png/ })).toBeDefined()
      expect(await pane.find({ type: 'Text', text: /notes\.txt\s+2 KB/ })).toBeDefined()
      await pane.press({ key: 'allow' })

      const result = await call
      expect(result.deny).toBeUndefined()
      expect(ran).toEqual(['rm -rf build notes.txt'])
      await pane.unmount()
    })
  }

  test('truncate opens the panel too', async ($, on) => {
    const { ran, clock } = host(on)
    const call = $.tool.call({ tool: 'Bash', command: 'truncate -s 0 notes.txt' })
    await clock.settle()
    expect(ran).toEqual([])
    const pane = await $.ui.mount({ plugin: 'delete-guard', surface: 'terminal', ...PANE })
    expect(await pane.find({ type: 'Text', text: /Claude wants to truncate 1 file/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /notes\.txt\s+2 KB\s+→ emptied/ })).toBeDefined()
    await pane.press({ key: 'allow' })
    expect((await call).deny).toBeUndefined()
    expect(ran).toEqual(['truncate -s 0 notes.txt'])
    await pane.unmount()
  })

  test('overwriting a file that is not there runs without a question', async ($, on) => {
    const { ran } = host(on)
    await $.tool.call({ tool: 'Bash', command: 'cp a.txt new.txt && echo hi > /p/fresh.log && echo x > /tmp/scratch.txt' })
    expect(ran).toEqual(['cp a.txt new.txt && echo hi > /p/fresh.log && echo x > /tmp/scratch.txt'])
  })

  for (const [command, change] of [
    ['cp other.txt notes.txt', 'overwritten by cp'],
    ['cp ../q/notes.txt /p', 'overwritten by cp'],
    ['echo hi > notes.txt', 'overwritten by a > redirect'],
  ] as const) {
    test(`overwriting an existing file asks first: ${command}`, async ($, on) => {
      const { ran, clock } = host(on)
      const call = $.tool.call({ tool: 'Bash', command })
      await clock.settle()
      expect(ran).toEqual([])
      const pane = await $.ui.mount({ plugin: 'delete-guard', surface: 'terminal', ...PANE })
      expect(await pane.find({ type: 'Text', text: /Claude wants to overwrite 1 file/ })).toBeDefined()
      expect(await pane.find({ type: 'Text', text: new RegExp(`notes\\.txt\\s+2 KB\\s+→ ${change}`) })).toBeDefined()
      await pane.press({ key: 'allow' })
      expect((await call).deny).toBeUndefined()
      expect(ran).toEqual([command])
      await pane.unmount()
    })
  }

  test('git restore lists the changed files it would throw away, not the deleted ones', async ($, on) => {
    const { ran, clock } = host(on)
    const call = $.tool.call({ tool: 'Bash', command: 'git restore .' })
    await clock.settle()
    const pane = await $.ui.mount({ plugin: 'delete-guard', surface: 'terminal', ...PANE })
    expect(await pane.find({ type: 'Text', text: /Claude wants to discard changes to 1 file/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /notes\.txt\s+2 KB\s+→ uncommitted changes discarded/ })).toBeDefined()
    await pane.press({ key: 'cancel' })
    expect((await call).deny).toMatch(/cancelled/)
    expect(ran).toEqual([])
    await pane.unmount()
  })

  test('Cancel refuses the delete and nothing runs', async ($, on) => {
    const { ran, clock } = host(on)
    const call = $.tool.call({ tool: 'Bash', command: 'rm -rf build' })
    await clock.settle()
    const pane = await $.ui.mount({ plugin: 'delete-guard', surface: 'terminal', ...PANE })
    await pane.press({ key: 'cancel' })

    const result = await call
    expect(result.deny).toMatch(/cancelled/)
    expect(ran).toEqual([])
    await pane.unmount()
  })

  test('with nobody to ask the delete is refused at once', async ($, on) => {
    const { ran } = host(on, [])
    const result = await $.tool.call({ tool: 'Bash', command: 'rm notes.txt' })
    expect(result.deny).toMatch(/nobody can be asked/)
    expect(ran).toEqual([])
  })
})
