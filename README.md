# vbc-mods

Claude Code mods for the VBC: displays and extensions for the terminal and the desktop app.

## Mods

| Mod | What it does |
|---|---|
| [context-meter](mods/context-meter/) | Context window and usage limits, always visible above the prompt |
| [delete-guard](mods/delete-guard/) | Stops Claude before it deletes files: a side panel lists what would go, with Cancel and Allow buttons |

## Install

In a Claude Code terminal session, install any mod from this repository with:

```
/plugin install <mod> --marketplace vienna-bio-center/claude-vbc-mods
```

for example:

```
/plugin install context-meter --marketplace vienna-bio-center/claude-vbc-mods
```

Answer `y` to add the marketplace (only asked the first time), then pick the **user** scope. The mod is active right away and in every session you start afterwards — including the desktop app's Code tab. The install command itself only works in the terminal.

## Adding a mod

1. Put the mod in its own folder under `mods/<name>/` (with `.claude-plugin/plugin.json`, `hooks/`, a `README.md`).
2. Add it to `.claude-plugin/marketplace.json`:
   ```json
   { "name": "<name>", "source": "./mods/<name>" }
   ```
3. Add a row to the table above.
4. Check everything:
   ```
   claude plugin validate .
   claude plugin validate mods/<name>
   claude plugin test mods/<name>
   ```

Bump `version` in the mod's `plugin.json` with every change you publish.

## License

[MIT](LICENSE) © 2026 Vienna BioCenter
