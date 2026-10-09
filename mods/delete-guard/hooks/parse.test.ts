import { describe, expect, test } from 'claude-code/testing'

import { bytes, expandBraces, findDeletes, joinPath, lex, segmentRegex, showPath, tilde } from './parse'
import type { Found } from './parse'

const targets = (command: string) =>
  findDeletes(command).found.map(f => (f.kind === 'paths' ? `${f.tool}:${f.words.map(w => w.text).join(',')}` : f.kind))

describe('finding deletes', () => {
  test('plain rm, rmdir, unlink, shred', async () => {
    expect(targets('rm -rf build dist')).toEqual(['rm:build,dist'])
    expect(targets('rm -- -weird-name')).toEqual(['rm:-weird-name'])
    expect(targets('rmdir empty')).toEqual(['rmdir:empty'])
    expect(targets('unlink x.txt')).toEqual(['unlink:x.txt'])
    expect(targets('shred -n 3 -u secret.key')).toEqual(['shred:secret.key'])
    expect(targets('/bin/rm a')).toEqual(['rm:a'])
  })

  test('commands that do not delete are left alone', async () => {
    expect(targets('ls -la && git status')).toEqual([])
    expect(targets('echo "rm -rf /"')).toEqual([])
    expect(targets("grep -r 'rm ' src")).toEqual([])
    expect(targets('git rm --cached file')).toEqual([])
    expect(targets('git clean -n -d')).toEqual([])
    expect(targets('find . -name "*.log"')).toEqual([])
    expect(targets('command -v rm')).toEqual([])
    expect(targets('# rm -rf x')).toEqual([])
  })

  test('every part of a chain is read', async () => {
    expect(targets('npm test && rm -f out.txt; rm -r tmp || true')).toEqual(['rm:out.txt', 'rm:tmp'])
    expect(targets('if [ -d x ]; then rm -r x; fi')).toEqual(['rm:x'])
    expect(targets('rm a\nrm b')).toEqual(['rm:a', 'rm:b'])
  })

  test('wrappers and nested shells', async () => {
    expect(targets('sudo -u root rm -rf /opt/x')).toEqual(['rm:/opt/x'])
    expect(targets('FOO=1 env -i nice -n 5 rm y')).toEqual(['rm:y'])
    expect(targets('timeout 10 rm z')).toEqual(['rm:z'])
    expect(targets(`bash -c 'rm -rf "my dir"'`)).toEqual(['rm:my dir'])
    expect(targets('sh -lc "cd sub && rm f"')).toEqual(['rm:f'])
    expect(targets('eval rm q')).toEqual(['rm:q'])
    expect(targets('echo $(rm -rf gone)')).toEqual(['rm:gone'])
    expect(targets('x=`rm old`')).toEqual(['rm:old'])
  })

  test('quotes, escapes and variables', async () => {
    const [f] = findDeletes(`rm "a b" 'c*' d\\ e $HOME/x "$OUT"/*.tmp`).found as [Extract<Found, { kind: 'paths' }>]
    expect(f.words.map(w => w.text)).toEqual(['a b', 'c*', 'd e', '$HOME/x', '$OUT/*.tmp'])
    expect(f.words.map(w => w.isDynamic)).toEqual([false, false, false, true, true])
    expect(f.words[1]!.pattern).toBe('c\\*')
  })

  test('cd moves the folder later parts run in, a subshell keeps it to itself', async () => {
    const found = findDeletes('cd build && rm -rf cache; (cd /tmp && rm x); rm y').found as Extract<Found, { kind: 'paths' }>[]
    expect(found.map(f => f.cwd)).toEqual([['build'], ['build', '/tmp'], ['build']])
    expect((findDeletes('cd "$DIR" && rm z').found[0] as { isCwdKnown: boolean }).isCwdKnown).toBe(false)
  })

  test('redirections are not targets', async () => {
    expect(targets('rm a 2>/dev/null')).toEqual(['rm:a'])
    expect(targets('rm b >log.txt 2>&1')).toEqual(['rm:b'])
  })

  test('find with -delete or -exec rm gets a dry run', async () => {
    const [f] = findDeletes(`find . -name '*.pyc' -delete`).found
    expect(f).toEqual({ kind: 'find', cwd: [], isCwdKnown: true, argv: ['find', '.', '(', '-name', '*.pyc', ')', '-print'], text: 'find . -name *.pyc -delete' })
    const [g] = findDeletes('find src -type f -exec rm {} +').found
    expect(g?.kind === 'find' && g.argv).toEqual(['find', 'src', '(', '-type', 'f', ')', '-print'])
    const [h] = findDeletes('find . -exec rm {} \\; -exec touch x \\;').found
    expect(h?.kind === 'find' && h.argv).toBe(null)
  })

  test('git clean gets a dry run, git rm lists its paths', async () => {
    const [f] = findDeletes('git -C repo clean -fdx').found
    expect(f?.kind === 'git-clean' && f.argv).toEqual(['git', 'clean', '-n', '-dx'])
    expect(f?.kind === 'git-clean' && f.cwd).toEqual(['repo'])
    expect(targets('git rm -r old/')).toEqual(['git rm:old/'])
  })

  test('truncate is caught unless it only grows the file', async () => {
    const change = (command: string) => findDeletes(command).found.map(f => f.kind === 'paths' && `${f.words.map(w => w.text).join(',')}: ${f.change}`)
    expect(change('truncate -s 0 app.log')).toEqual(['app.log: emptied, the file stays'])
    expect(change('truncate --size=10K a b')).toEqual(['a,b: size set to 10K'])
    expect(change('truncate -cs-1M big.bin')).toEqual(['big.bin: shortened by 1M'])
    expect(change('truncate -r ref.txt out.txt')).toEqual(['out.txt: size set to that of ref.txt'])
    expect(change('sudo truncate -s0 -- -x')).toEqual(['-x: emptied, the file stays'])
    expect(targets('truncate -s +1M disk.img')).toEqual([])
    expect(targets('truncate -s %4K disk.img')).toEqual([])
    expect(targets('truncate --help')).toEqual([])
    expect(findDeletes('truncate -s 0 a.log').isOnlyDeletes).toBe(true)
  })

  test('xargs rm and rsync --delete are named but cannot be listed', async () => {
    expect(targets('find . -name x | xargs rm -f')).toEqual(['opaque'])
    expect(targets('rsync -a --delete src/ dst/')).toEqual(['opaque'])
  })

  test('only a command that does nothing but delete is marked so', async () => {
    expect(findDeletes('rm -rf build').isOnlyDeletes).toBe(true)
    expect(findDeletes('cd x && rm y').isOnlyDeletes).toBe(true)
    expect(findDeletes('rm -rf build && npm install').isOnlyDeletes).toBe(false)
    expect(findDeletes('rm x > log').isOnlyDeletes).toBe(false)
    expect(findDeletes('echo $(rm a)').isOnlyDeletes).toBe(false)
    expect(findDeletes('cat list | xargs rm').isOnlyDeletes).toBe(false)
  })
})

describe('paths', () => {
  test('braces expand like bash', async () => {
    expect(expandBraces('a.{txt,log}')).toEqual(['a.txt', 'a.log'])
    expect(expandBraces('f{1..3}')).toEqual(['f1', 'f2', 'f3'])
    expect(expandBraces('x\\{a,b\\}')).toEqual(['x\\{a,b\\}'])
    expect(expandBraces('{a,b}{1,2}')).toEqual(['a1', 'a2', 'b1', 'b2'])
  })

  test('glob segments match like bash, dotfiles only on purpose', async () => {
    expect(segmentRegex('*.log').test('a.log')).toBe(true)
    expect(segmentRegex('*.log').test('.hidden.log')).toBe(false)
    expect(segmentRegex('.*').test('.env')).toBe(true)
    expect(segmentRegex('file?.[ch]').test('file1.c')).toBe(true)
    expect(segmentRegex('[!a]*').test('abc')).toBe(false)
    expect(segmentRegex('a\\*b').test('a*b')).toBe(true)
    expect(segmentRegex('a\\*b').test('axxb')).toBe(false)
  })

  test('joinPath folds . and ..', async () => {
    expect(joinPath('/home/u/p', 'a/../b/./c')).toBe('/home/u/p/b/c')
    expect(joinPath('/home/u/p', '/etc/x')).toBe('/etc/x')
    expect(joinPath('/', 'tmp')).toBe('/tmp')
  })

  test('showPath and bytes', async () => {
    expect(showPath('/home/u/p/build', '/home/u/p', '/home/u')).toBe('build')
    expect(showPath('/home/u/other', '/home/u/p', '/home/u')).toBe('~/other')
    expect(showPath('/etc/x', '/home/u/p', '/home/u')).toBe('/etc/x')
    expect(tilde('/home/u/p', '/home/u')).toBe('~/p')
    expect(tilde('/tmp/w', '/home/u')).toBe('/tmp/w')
    expect(bytes(500)).toBe('500 B')
    expect(bytes(2048)).toBe('2 KB')
    expect(bytes(3.5 * 1024 * 1024)).toBe('3.5 MB')
  })

  test('lex keeps operators apart from words', async () => {
    const { tokens } = lex('a&&b|c;d')
    expect(tokens.map(t => (t.type === 'op' ? t.op : t.word.text))).toEqual(['a', '&&', 'b', '|', 'c', ';', 'd'])
  })
})
