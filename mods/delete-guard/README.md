# delete-guard

> [!IMPORTANT]
> **delete-guard does not stop scripts that delete files.** It only recognises delete commands that Claude types directly into its shell (`rm`, `git clean`, `find -delete`, …). If Claude writes a script (Python, shell, Node, …) that deletes files, or runs an existing one, the panel does not open and the files are deleted without asking. Treat the mod as a safety net for everyday commands, not as protection against data loss.

A Claude Code mod that stops Claude before it deletes files, or overwrites or empties files that hold something. A side panel lists every folder and file the command would remove or change, with **Cancel** and **Allow** buttons underneath. Nothing happens until you press one of them.

```
Delete Guard
Claude wants to delete 1 folder (2 files inside), 1 file
in ~/projects/analysis
$ rm -rf junk keep.txt nothere.log

Folders (1)
  ▸ junk/
     2 files, 1 folder, 4 KB
     a.txt
     sub/
     sub/b.txt
Files (1)
  • keep.txt  5 B
Not there (nothing to delete) (1)
  nothere.log  does not exist

[ Cancel ] [ Allow ]
```

- **Cancel**: the command does not run. Claude is told you cancelled it and not to try again another way.
- **Allow**: the command runs.
- Closing the panel with its **✕**, or interrupting Claude with **Esc**, counts as Cancel.

## Install

In a Claude Code terminal session:

```
/plugin install delete-guard --marketplace vienna-bio-center/claude-vbc-mods
```

Answer `y` to add the marketplace, then pick the **user** scope. The mod is active right away and in every session you start afterwards — including the desktop app's Code tab. (The install command itself only works in the terminal.)

## Usage

Nothing to start. Whenever Claude runs a shell command that deletes or overwrites something, the panel opens on its own and the command waits for your answer, however long that takes.

In the terminal: **Tab** moves between the buttons, **Enter** presses one, **n** is Cancel. A mouse click works too.

If the panel is closed while a delete waits, `/delete-guard` opens it again.

### What it catches

**Deleting** — always asked about:

| Command | What the panel lists |
|---|---|
| `rm`, `rmdir`, `unlink`, `shred`, `trash`, `gio trash`, `rimraf` | the named paths, with wildcards (`*.log`), `{a,b}`, `{01..10}` and `~` expanded; for a folder its size, file count and the first few entries |
| `truncate` (not when it only grows a file: `-s +N`) | the named files, each with what happens to it (`→ emptied, the file stays`) |
| `git rm` (not `--cached`) | the named paths |
| `git clean` | exactly what `git clean -n` (dry run) reports |
| `find … -delete`, `find … -exec rm …` | the matches of the same `find`, with the delete swapped for `-print` |
| `xargs rm`, `rsync --delete`/`--del`, `gio trash --empty`, `trash-empty`, `dd of=/dev/…`, `git stash drop`/`clear`, `git worktree remove --force` | a note that the targets can't be known beforehand |

**Overwriting and throwing away changes** — asked about only when something is at stake:

| Command | Asked when … |
|---|---|
| `> file`, `>\| file`, `&> file` (not `>>`) | the file exists and is not empty |
| `cp`, `mv`, `install` (not with `-n`, `-i`, `-b`), `ln -f` | the file they write to exists |
| `tee` (not `-a`), `dd of=file` | the file exists (for `tee`: and is not empty) |
| `git reset --hard`, `git restore`, `git checkout <file>`, `git checkout -- …`, `git checkout -f`, `git switch --discard-changes` | there are uncommitted changes in the files it touches; `git reset --hard <commit>` always |

Files in `/tmp`, `$TMPDIR` and `/dev`, and targets named by a variable (`> $LOG`), are not asked about.

It also looks inside `cmd1 && cmd2`, `;`, pipes, `sudo …`, `env …`, `command …`, `bash -c "…"`, `npx …`/`npm exec …`, `$( … )`, `find -exec …` and `xargs …`, and follows a `cd` (or `env -C`) earlier in the same command. Paths that depend on a variable (`rm $OUT/x`) are listed as *known only when it runs*.

## Good to know

- **Only Claude's shell (Bash tool) is watched.** Deletes through other tools (for example an MCP connector's own delete) are not caught.
- **Best effort, not a sandbox.** The mod reads the command the way bash would and errs on the side of asking. Deletes inside scripts are not recognised (see the note at the top), nor are deliberately disguised commands.
- **Not a backup.** After you press Allow, the files are gone as usual.
- **Narrow terminal:** Claude Code shows a panel it opens on its own only from about 144 columns (110 once you have opened it before). Below that, the mod asks in Claude Code's normal question dialog instead, with a one-line summary.
- **Claude Code's own permission question:** if the command does nothing but delete, your Allow is enough. Claude Code still asks its usual question afterwards when the command also does something else (`rm -r build && npm install`), overwrites rather than deletes (`cp`, `>`, `git restore`), or might run something other than the plain command: a variable set in front (`PATH=… rm`), a program from a folder (`./rm`), a package runner (`npx rimraf`), git options such as `git -c …`, or a login shell (`bash -lc`). Deny rules in your settings always win.
- **Previews run nothing of the command's own:** the dry runs (`find … -print`, `git clean -n`, `git status`) leave out the command's `-c …` and other global git flags, switch off `core.fsmonitor`, and run only in this session's own repository. For another repository the panel says the targets can't be listed beforehand.
- **`claude -p` and other runs where nobody can answer:** deletes are refused.
- **Waiting** uses a sleeping `sleep` process (PowerShell `Start-Sleep` on Windows) that ends as soon as you answer. This is how a mod can wait longer than Claude Code's 10-second limit for mods.
- Tested on Linux and macOS in the terminal. Windows is not tested.

## Development

```
claude plugin validate <path-to-this-folder>
claude plugin test <path-to-this-folder>
```

To run a working copy instead of the installed version, start Claude Code with `claude --plugin-dir <path-to-this-folder>`.

## License

[MIT](../../LICENSE) © 2026 Vienna BioCenter
