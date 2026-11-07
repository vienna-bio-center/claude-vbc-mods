# slurm-watch

> [!IMPORTANT]
> **slurm-watch only follows jobs Claude submits itself with `sbatch`.** It reads the job id from what `sbatch` prints in Claude's shell. Jobs you submit yourself, or that a script submits without printing `Submitted batch job …`, are not followed.

A Claude Code mod that keeps an eye on the Slurm jobs Claude submits, on CBE.next or another Slurm cluster you allow. It shows their state in the status line and in a jobs panel. When a job ends, it lets you know, and it tells Claude.

```
Slurm: 2 running · 1 pending · 1 failed
```

```
Slurm jobs
4 jobs · last check 2m ago · next in 1m

Job     Name             State          Elapsed     Exit   Host            Sent
4243    align            running        00:41:12           cbe.next        43m    ✕
4251    qc-array         pending        3/20               cbe.next        5m     ✕
4240    sort             out of memory  00:02:10    0:125  cbe.next        1h10   ✕

[ Refresh ]  [ Clear finished ]
```

- **Status line:** how many jobs are running, pending, done and failed. `⚠ see /slurm-jobs` when Slurm could not be asked.
- **When a job ends:** a short message in Claude Code, a desktop notification, and a note in the conversation of the session that submitted it, such as `- Slurm job 4240 (job name: sort) on cbe.next ended: OUT_OF_MEMORY (exit code 0:125, elapsed 00:02:10).` Claude reads it with your next prompt. No new turn is started. The note says that it comes from the mod, not from you.
- **Across sessions:** jobs are kept after you close Claude Code. A new session keeps following them and reports jobs that ended in the meantime. Ended jobs leave the list after 24 hours.

## Install

In a Claude Code terminal session:

```
/plugin install slurm-watch --marketplace vienna-bio-center/claude-vbc-mods
```

Answer `y` to add the marketplace, then pick the **user** scope. The mod is active right away and in every session you start afterwards, including the desktop app's Code tab. (The install command itself only works in the terminal.)

## Usage

There is nothing to start. As soon as Claude runs `sbatch`, either on the cluster or through `ssh cbe.next "sbatch …"`, the job appears in the status line.

To see the full list, run:

```
/slurm-jobs
```

| In the panel | What it does |
|---|---|
| **Refresh** | asks Slurm now (at most once every 30 seconds) |
| **Clear finished** | removes all jobs that have ended |
| **✕** | removes one job from the list; the job itself keeps running |

## Settings

| Setting | Default | What it does |
|---|---|---|
| `hosts` | `cbe.next, *.vbc.ac.at` | The ssh hosts slurm-watch may contact: names and `*.domain` patterns, separated by commas. A job sent to any other host (or through a jump host not listed) is shown as `not checked` and never asked about. Jobs Claude submits on the machine it runs on are always checked. |

Change it with `/config`, or in `~/.claude/settings.json` under `pluginConfigs` (the mod's entry, `options.hosts`).

## How it asks Slurm

| Claude submitted with | slurm-watch asks with |
|---|---|
| `sbatch …` (Claude runs on a login node) | `sacct -X -n -P -j <ids> -o JobID,JobName,State,Elapsed,ExitCode -u $USER` |
| `ssh [-J jump] [-p port] [user@]host "… sbatch …"`, also with a here-document | the same `sacct` on that host, via `ssh -T -a -x -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=yes -o ClearAllForwardings=yes -o PermitLocalCommand=no [-p port] [-l user] [-J jump] -- host` |

- **Only `sbatch` that actually runs counts**, directly, over ssh (also through a here-document or `bash -lc '…'`), or through `xargs`, `parallel` and `find -exec`. `cat sbatch.log`, `grep sbatch …` or `echo "… sbatch …"` add no job, even if their output contains `Submitted batch job`.
- **Every 3 minutes at most**, and only while a job is pending or running. All jobs on one host are asked about in a single `sacct` call. Slurm's scheduler is shared, and CBE.next limits users who query it too often.
- **Once more 30 seconds after a submit**, so that the name and first state show up.
- **A host that fails rests**: 10 minutes, doubling up to an hour, while other hosts go on as usual. After two days without an answer its jobs are given up as `unknown`.
- **Only the jump host, port and login name are taken from Claude's ssh command.** Other options, such as `-o ProxyCommand=…` or `-i key`, are never repeated: put what a host needs in `~/.ssh/config`. A host spelled in an unusual way is not contacted at all.
- **Nothing is forwarded:** no ssh agent, no X11, no ports, no `LocalCommand`, whatever `~/.ssh/config` says for the host.
- **Several open sessions share one schedule**, so Slurm is rarely asked twice.

## Good to know

- **SSH certificate:** on CBE.next, ssh logs in with a certificate that is valid for 16 hours. Once it has expired, the panel says `ssh login to cbe.next failed. Renew your certificate (step ssh login vbc-cbe) …`. The mod never asks for a password and never accepts an unknown host key (`BatchMode=yes`, `StrictHostKeyChecking=yes`): ssh fails instead of asking.
- **What reaches Claude is cleaned:** job names keep only letters, digits and `._+=@:/-` (anything else becomes `_`, at most 40 characters); state, elapsed time and exit code are taken only in Slurm's own format. A job name comes from a job script, so the note marks it as data.
- **Off campus**, the cluster is only reachable through the jump host. The mod uses it if Claude's command used it (`ssh -J sshjump.vbc.ac.at …`) or if your `~/.ssh/config` sets it up for the host.
- **Job arrays** show as one row with `done/total` tasks. The row's state is the worst state of its tasks.
- **Jobs that `sacct` does not list** are marked `unknown` after three checks in a row without them, counted from an hour after the submit at the earliest (Slurm's accounting can lag).
- **Two sessions at once:** in rare cases the end of a job may be reported twice.
- **Subagents:** jobs a subagent submits are followed too. Its conversation is not told; the line goes to the main conversation.
- Tested with `claude plugin test` on macOS. Not yet tested against a live cluster.

## Development

```
claude plugin validate <path-to-this-folder>
claude plugin test <path-to-this-folder>
```

To run a working copy instead of the installed version, start Claude Code with `claude --plugin-dir <path-to-this-folder>`.

## License

[MIT](../../LICENSE) © 2026 Vienna BioCenter
