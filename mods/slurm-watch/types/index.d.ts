/** Where the mod asks Slurm about a job: on this machine, or over ssh to the host Claude used. */
export type Via = { kind: 'local' } | { kind: 'ssh'; host: string; jump?: string; port?: string; user?: string }

export type Job = {
  /** The job id Slurm printed, digits only. */
  id: string
  /** `on cluster <name>` from sbatch, for `sacct -M`; null on a single cluster. */
  cluster: string | null
  /** null when the command was not one the mod can repeat safely: the job is shown, never asked about. */
  via: Via | null
  name: string
  /** Slurm's state word (`PENDING`, `RUNNING`, `FAILED` …), or `SUBMITTED` before the first answer, `UNKNOWN` once sacct stops listing it. */
  state: string
  elapsed: string
  exitCode: string
  /** For a job array: how many tasks have ended, of how many. */
  tasks: { done: number; total: number } | null
  submittedAt: number
  endedAt: number | null
  /** The session that submitted it: the one whose conversation hears that it ended. */
  owner: string
  /** Polls in a row that did not list the job. */
  misses: number
  /** Toast and notification shown (by whichever session saw the end first). */
  notified: boolean
  /** The owning session's conversation was told. */
  told: boolean
}

export type Poll = {
  lastAt: number
  /** Earliest time the next regular poll may run (later after an error). */
  nextAt: number
  /** What went wrong per host, keyed by `viaKey`. */
  errors: Record<string, string>
  /** Per host that failed: no regular poll before `until`; `since` the first failure in a row. */
  backoff: Record<string, Backoff>
}

export type Backoff = { until: number; since: number; tries: number }

declare module 'claude-code' {
  interface PluginState {
    'slurm-watch': {
      jobs: Job[]
      poll: Poll
      now: number
    }
  }
}
