# context-meter

A Claude Code mod that keeps your context window and usage limits in view, right above the prompt — in the terminal and in the desktop app.

```
Context ██▓▓▓▓▒▒░░░░░░░░░░░░ 20% · 40k / 200k          Details  5h ██░░░ 42% ↻2h10
■ Messages 36k  ■ System tools 14k  ■ Skills 10k                        7d ████░ 86% ↻3d
```

- **Row 1:** context fill as a bar colored by category, percentage, tokens used / window size, and your 5-hour limit with the time until it resets.
- **Row 2:** the largest context categories, and your weekly limit (plus a spend limit, if your account has one).
- **Colors:** green below 50 %, yellow from 50 %, red from 80 %.

## Install

In a Claude Code terminal session:

```
/plugin install context-meter --marketplace vienna-bio-center/claude-vbc-mods
```

Answer `y` to add the marketplace, then pick the **user** scope. The mod is active right away and in every session you start afterwards — including the desktop app's Code tab. (The install command itself only works in the terminal.)

## Usage

Nothing to start: the band appears on its own once a session has its first response.

For a breakdown, press **Details** in the band or run:

```
/context-details
```

The details pane lists:

| Section | What it shows |
|---|---|
| Categories | every context category with tokens and share of the window |
| Largest tool results | the 10 biggest tool outputs since the last `/clear` or compact |
| MCP servers | tokens per server for tool schemas currently loaded |
| Memory files | CLAUDE.md, rules and auto-memory files with their size |
| Skills / agents | what the skill listing and agent descriptions cost |

## Good to know

- **Updates:** after every model response (also mid-turn), at the end of each turn, and every minute for the reset countdowns. No polling, no extra API calls.
- **Estimates:** category figures are the same local estimate `/context` uses in summary mode. Tool result sizes are approximate (characters ÷ 4). Run `/context` for an exact count.
- **Usage limits** appear only on a Claude subscription and only after the session's first response — before that there is no reading.
- **Narrow windows:** below 110 columns the small limit bars are dropped, below 90 the reset times too.
- **Subagents** are not counted: their responses and tool results don't land in your main context.

## Development

```
claude plugin validate <path-to-this-folder>
claude plugin test <path-to-this-folder>
```

To run a working copy instead of the installed version, start Claude Code with `claude --plugin-dir <path-to-this-folder>`.
