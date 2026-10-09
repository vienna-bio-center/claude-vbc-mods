import { describe, expect, test } from 'claude-code/testing'

import { bytes, expandBraces, findDeletes, joinPath, lex, segmentRegex, showPath, tilde } from './parse'
import type { Found } from './parse'

const targets = (command: string) =>
  findDeletes(command).found.map(f =>
    f.kind === 'paths' ? `${f.tool}:${f.words.map(w => w.text).join(',')}` : f.kind === 'overwrite' ? `${f.tool}>${f.dest.text}` : f.kind,
  )
const only = (command: string) => findDeletes(command).isOnlyDeletes

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

  test('a redirect that empties a file is an overwrite; appending and 2>&1 are not', async () => {
    expect(targets('rm a 2>/dev/null')).toEqual(['>>/dev/null', 'rm:a'])
    expect(targets('rm b >log.txt 2>&1')).toEqual(['>>log.txt', 'rm:b'])
    expect(targets('echo x >> log.txt')).toEqual([])
    expect(targets(': > a.log; cat /dev/null >| b.log; make &> c.log; make >& d.log')).toEqual(['>>a.log', '>>b.log', '>>c.log', '>>d.log'])
    expect(targets('cat <<EOF\nhi\nEOF')).toEqual([])
  })

  test('find with -delete or -exec rm gets a dry run', async () => {
    const [f] = findDeletes(`find . -name '*.pyc' -delete`).found
    expect(f).toEqual({ kind: 'find', cwd: [], isCwdKnown: true, argv: ['find', '.', '-depth', '-name', '*.pyc', '-print'], text: 'find . -name *.pyc -delete' })
    const [g] = findDeletes('find src -type f -exec rm {} +').found
    expect(g?.kind === 'find' && g.argv).toEqual(['find', 'src', '-type', 'f', '-print'])
    const [h] = findDeletes('find . -exec rm {} \\; -exec touch x \\;').found
    expect(h?.kind === 'find' && h.argv).toBe(null)
  })

  test('find keeps the order of its tests: a delete is swapped for -print in place', async () => {
    const [f] = findDeletes(`find . -type f -delete -name '*.tmp'`).found
    expect(f?.kind === 'find' && f.argv).toEqual(['find', '.', '-depth', '-type', 'f', '-print', '-name', '*.tmp'])
  })

  test('find -exec: wrappers count, extra paths are listed too', async () => {
    expect(targets('find . -exec sudo rm {} +')).toEqual(['find'])
    expect(targets('find . -name cache -exec rm -rf /important {} +')).toEqual(['find', 'rm:/important'])
    expect(targets('find . -name x -exec cp {} backup/ \\;')).toEqual([])
  })

  test('git clean gets a dry run, git rm lists its paths', async () => {
    const [f] = findDeletes('git -C repo clean -fdx').found
    expect(f?.kind === 'git-clean' && f.argv).toEqual(['git', '-c', 'core.fsmonitor=false', '--no-optional-locks', 'clean', '-n', '-d', '-x', '--'])
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

  test("a dry run never takes the command's own git config or global flags", async () => {
    const [f] = findDeletes(`git -c 'core.fsmonitor=touch MARK' --exec-path=/x clean -fd --interactive -e keep.txt`).found
    expect(f?.kind === 'git-clean' && f.argv).toEqual(['git', '-c', 'core.fsmonitor=false', '--no-optional-locks', 'clean', '-n', '-d', '--exclude=keep.txt', '--'])
    const [g] = findDeletes('GIT_DIR=/x git clean -fd').found
    expect(g?.kind === 'git-clean' && g.argv).toBe(null)
    const [h] = findDeletes('git --git-dir=elsewhere --work-tree=. clean -fd').found
    expect(h?.kind === 'git-clean' && h.argv).toBe(null)
  })

  test('a value is not a flag: `-e -n` excludes "-n", it is no dry run', async () => {
    expect(targets('git clean -fd -e -n')).toEqual(['git-clean'])
    expect(targets('git clean -fd --exclude -n')).toEqual(['git-clean'])
    expect(targets('git clean -fd -en')).toEqual(['git-clean'])
    expect(targets('git clean -fd --dry')).toEqual([])
    expect(targets('git rm --cach a')).toEqual([])
  })

  test('only a pure delete lets the panel answer for Claude Code too', async () => {
    expect(only('find . -exec rm {} \\; -exec touch marker \\;')).toBe(false)
    expect(only('rm build; command curl -v https://example.com')).toBe(false)
    expect(only('cp a b && rm a')).toBe(false)
    expect(only('git restore x.txt')).toBe(false)
    expect(only('find . -name x -delete')).toBe(true)
    expect(only('git rm -r old')).toBe(true)
  })

  test('wrappers, shells and runners that used to slip through', async () => {
    expect(targets('command rm -v victim')).toEqual(['rm:victim'])
    expect(targets('command -v rm')).toEqual([])
    expect(targets('sudo --user root rm victim')).toEqual(['rm:victim'])
    expect(targets('sudo --user=root rm victim')).toEqual(['rm:victim'])
    expect(targets(`env -S 'rm -rf build'`)).toEqual(['rm:build'])
    expect(targets(`bash -cf 'rm victim'`)).toEqual(['rm:victim'])
    expect(targets(`bash -c -- 'rm victim'`)).toEqual(['rm:victim'])
    expect(targets(`bash -o pipefail -c 'rm victim'`)).toEqual(['rm:victim'])
    expect(targets('npx rimraf build')).toEqual(['rimraf:build'])
    expect(targets('npx -y rimraf build')).toEqual(['rimraf:build'])
    expect(targets('npm exec -- rimraf build')).toEqual(['rimraf:build'])
    expect(targets('pnpm dlx rimraf build')).toEqual(['rimraf:build'])
    expect(targets(`npx -c 'rm x'`)).toEqual(['rm:x'])
  })

  test('env -C and sudo -D move only that one command', async () => {
    const found = findDeletes('env -C /other rm victim; sudo -D /srv rm y; rm z').found as Extract<Found, { kind: 'paths' }>[]
    expect(found.map(f => f.cwd)).toEqual([['/other'], ['/srv'], []])
  })

  test('git rm, rsync and the trash in their other spellings', async () => {
    expect(targets('xargs git rm')).toEqual(['opaque'])
    expect(targets('git rm --pathspec-from-file=paths.txt')).toEqual(['opaque'])
    expect(targets('git rm -- --cached')).toEqual(['git rm:--cached'])
    expect(targets('rsync -a --del src/ dst/')).toEqual(['opaque'])
    expect(targets('rsync -a --delete-after src/ dst/')).toEqual(['opaque'])
    expect(targets('gio trash --empty')).toEqual(['opaque'])
    expect(targets('trash-empty')).toEqual(['opaque'])
  })

  test('cp, mv, install, tee and dd name what they write to', async () => {
    const found = (command: string) =>
      findDeletes(command).found.map(f => f.kind === 'overwrite' && `${f.tool} ${f.sources.map(w => w.text).join(',')} -> ${f.dest.text} ${f.intoDir}`)
    expect(found('cp a.txt b.txt')).toEqual(['cp a.txt -> b.txt null'])
    expect(found('cp -r a b dir')).toEqual(['cp a,b -> dir true'])
    expect(found('mv -t dir a')).toEqual(['mv a -> dir true'])
    expect(found('cp -T a b')).toEqual(['cp a -> b false'])
    expect(found('install -m 644 a /usr/local/bin/a')).toEqual(['install a -> /usr/local/bin/a null'])
    expect(found('cp -n a b')).toEqual([])
    expect(found('mv -i a b')).toEqual([])
    expect(found('cp --backup=numbered a b')).toEqual([])
    expect(found('install -d dir')).toEqual([])
    expect(targets('tee out.txt')).toEqual(['tee>out.txt'])
    expect(targets('tee -a out.txt')).toEqual([])
    expect(targets('dd if=a of=b.img')).toEqual(['dd>b.img'])
    expect(targets('dd if=a of=/dev/disk2')).toEqual(['opaque'])
    expect(targets('dd if=a of=/dev/null')).toEqual(['dd>/dev/null'])
  })

  test('git commands that throw away uncommitted changes', async () => {
    const discard = (command: string) =>
      findDeletes(command).found.map(f => f.kind === 'git-discard' && `${f.scope} ${f.argv?.slice(f.argv.indexOf('--') + 1).join(',')}${f.note ? ' !' : ''}`)
    expect(discard('git reset --hard')).toEqual(['all '])
    expect(discard('git reset --hard origin/main')).toEqual(['all  !'])
    expect(discard('git reset --soft HEAD~1')).toEqual([])
    expect(discard('git restore a.txt')).toEqual(['worktree a.txt'])
    expect(discard('git restore --staged a.txt')).toEqual([])
    expect(discard('git restore -SW a.txt')).toEqual(['all a.txt'])
    expect(discard('git checkout -- a.txt')).toEqual(['worktree a.txt'])
    expect(discard('git checkout main -- a.txt')).toEqual(['all a.txt'])
    expect(discard('git checkout .')).toEqual(['worktree .'])
    expect(discard('git checkout -f main')).toEqual(['all '])
    expect(discard('git checkout src/app.ts')).toEqual(['worktree src/app.ts'])
    expect(discard('git checkout main src/')).toEqual(['all main,src/'])
    expect(discard('git checkout -b feature')).toEqual([])
    expect(discard('git switch --discard-changes main')).toEqual(['all '])
    const [f] = findDeletes(`git -c core.fsmonitor=evil restore x`).found
    expect(f?.kind === 'git-discard' && f.argv?.slice(0, 4)).toEqual(['git', '-c', 'core.fsmonitor=false', '--no-optional-locks'])
  })

  test('only a plain command can be answered for Claude Code: no PATH tricks, local programs, runners or git config', async () => {
    for (const command of [
      'PATH=./bin rm x',
      'LD_PRELOAD=./x.so rm a',
      'env PATH=/evil rm x',
      './rm -rf build',
      './timeout 1 rm x',
      './git clean -fd',
      "git -c core.fsmonitor='touch /tmp/pwn' clean -fdx",
      'GIT_CONFIG_PARAMETERS=x git rm a',
      'npx -p evil-pkg rimraf dist',
      'pnpm dlx rimraf dist',
      `bash --rcfile ./r -ic 'rm x'`,
      `bash -lc 'rm x'`,
      'rm ${X:-$(id)}',
      'rm $(( $(id) ))',
    ])
      expect([command, only(command)]).toEqual([command, false])
    expect(targets('./rm -rf build')).toEqual(['rm:build'])
    expect(only('/bin/rm x')).toBe(true)
    expect(only('git -C repo rm a')).toBe(true)
    expect(only(`bash -ec 'rm x'`)).toBe(true)
    expect(only('rm ${X}/a')).toBe(true)
  })

  test('a here-doc body is text: quotes and > in it hide nothing and ask about nothing', async () => {
    expect(targets("cat <<EOF\nit's\nEOF\nrm -rf src")).toEqual(['rm:src'])
    expect(targets("cat > s.sh <<'EOF'\necho hi > README.md\nEOF")).toEqual(['>>s.sh'])
    expect(targets('cat <<EOF\n$(rm -rf x)\nEOF')).toEqual(['rm:x'])
    expect(targets("cat <<-'X'\n\trm y\n\tX\nrm z")).toEqual(['rm:z'])
  })

  test('grouped and glued wrapper flags, xargs options', async () => {
    expect(targets('sudo -nu root rm -rf /x')).toEqual(['rm:/x'])
    expect(targets("env -S'rm -rf /important'")).toEqual(['rm:/important'])
    expect(targets('xargs --max-procs 4 rm -rf')).toEqual(['opaque'])
    expect(targets('xargs -J % rm -rf %')).toEqual(['opaque', 'rm:%'])
    const [f] = findDeletes('env -Cbuild rm -rf dist').found
    expect(f?.kind === 'paths' && f.cwd).toEqual(['build'])
  })

  test("find's own -print does not widen the preview", async () => {
    const [f] = findDeletes(`find . -print -name '*.log' -delete`).found
    expect(f?.kind === 'find' && f.argv).toEqual(['find', '.', '-depth', '-true', '-name', '*.log', '-print'])
  })

  test('ln -f, git stash drop/clear and git worktree remove --force', async () => {
    expect(targets('ln -sf other existing.txt')).toEqual(['ln>existing.txt'])
    expect(targets('ln -s other new.txt')).toEqual([])
    expect(targets('git stash drop')).toEqual(['opaque'])
    expect(targets('git stash clear')).toEqual(['opaque'])
    expect(targets('git stash')).toEqual([])
    expect(targets('git worktree remove --force ../wt')).toEqual(['opaque'])
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
  test('brace ranges keep zero padding and stop at a limit', async () => {
    expect(expandBraces('f{01..03}')).toEqual(['f01', 'f02', 'f03'])
    expect(expandBraces('f{1..1002}')).toBe(null)
    expect(expandBraces('{1..40}{1..40}')).toBe(null)
    expect(expandBraces('file{1..9..2}')).toEqual(['file1', 'file3', 'file5', 'file7', 'file9'])
    expect(expandBraces('f{a..c}')).toEqual(['fa', 'fb', 'fc'])
    expect(expandBraces('f{a..3}')).toEqual(['f{a..3}'])
  })

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
    expect(tokens.map(t => (t.type === 'op' ? t.op : t.type === 'redirect' ? `>${t.mode}` : t.word.text))).toEqual(['a', '&&', 'b', '|', 'c', ';', 'd'])
  })
})
