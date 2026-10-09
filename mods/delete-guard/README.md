# delete-guard

> [!IMPORTANT]
> **delete-guard does not stop scripts that delete files.** It only recognises delete commands that Claude types directly into its shell (`rm`, `git clean`, `find -delete`, …). If Claude writes a script (Python, shell, Node, …) that deletes files, or runs an existing one, the panel does not open and the files are deleted without asking. Treat the mod as a safety net for everyday commands, not as protection against data loss.

A Claude Code mod that stops Claude before it deletes files. A side panel lists every folder and file the command would remove, with **Cancel** and **Allow delete** buttons underneath. Nothing is deleted until you press one of them.

```
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

[ Cancel ] [ Allow delete ]
```

- **Cancel**: the command does not run. Claude is told you cancelled it and not to try again another way.
- **Allow delete**: the command runs.
- Closing the panel with its **✕**, or interrupting Claude with **Esc**, counts as Cancel.

## Install

In a Claude Code terminal session:

```
/plugin install delete-guard --marketplace vienna-bio-center/claude-vbc-mods
```

Answer `y` to add the marketplace, then pick the **user** scope. The mod is active right away and in every session you start afterwards — including the desktop app's Code tab. (The install command itself only works in the terminal.)

## Usage

Nothing to start. Whenever Claude runs a shell command that deletes something, the panel opens on its own and the command waits for your answer, however long that takes.

In the terminal: **Tab** moves between the buttons, **Enter** presses one, **n** is Cancel. A mouse click works too.

If the panel is closed while a delete waits, `/delete-guard` opens it again.

### What counts as deleting

| Command | What the panel lists |
|---|---|
| `rm`, `rmdir`, `unlink`, `shred`, `trash`, `gio trash`, `rimraf` | the named paths, with wildcards (`*.log`), `{a,b}` and `~` expanded; for a folder its size, file count and the first few entries |
| `truncate` (not when it only grows a file: `-s +N`) | the named files, each with what happens to it (`→ emptied, the file stays`); the panel then says *truncate* instead of *delete* |
| `git rm` (not `--cached`) | the named paths |
| `git clean` | exactly what `git clean -n` (dry run) reports |
| `find … -delete`, `find … -exec rm …` | the matches of the same `find` without the delete |
| `xargs rm`, `rsync --delete` | a note that the targets can't be known beforehand |

It also looks inside `cmd1 && cmd2`, `;`, pipes, `sudo …`, `bash -c "…"`, `$( … )`, and follows a `cd` earlier in the same command. Paths that depend on a variable (`rm $OUT/x`) are listed as *known only when it runs*.

## Good to know

- **Only Claude's shell (Bash tool) is watched.** Deletes through other tools (for example an MCP connector's own delete) are not caught.
- **Best effort, not a sandbox.** The mod reads the command the way bash would and errs on the side of asking. Deletes inside scripts are not recognised (see the note at the top), nor are deliberately disguised commands.
- **Not a backup.** After you press Allow, the files are gone as usual.
- **Narrow terminal:** Claude Code shows a panel it opens on its own only from about 144 columns (110 once you have opened it before). Below that, the mod asks in Claude Code's normal question dialog instead, with a one-line summary.
- **Claude Code's own permission question:** if the command does nothing but delete, your Allow is enough. If it also does something else (`rm -r build && npm install`), Claude Code still asks its usual question afterwards. Deny rules in your settings always win.
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
