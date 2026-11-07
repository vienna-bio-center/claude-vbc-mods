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
  /** What the job asked for and used, from sacct; null before the first reading (and for jobs stored by 0.1.0). */
  usage: Usage | null
}

/** Requested against used, as `jobeff` counts it; a figure sacct did not give is null. */
export type Usage = {
  /** TotalCPU over the CPU time allocated (CPUTimeRAW), in percent. */
  cpuPct: number | null
  /** CPUs allocated (per task for an array). */
  cpus: number | null
  /** The most tasks a step ran, and the nodes allocated: hints that assume one task on one node check these. */
  tasks: number | null
  nodes: number | null
  /** The highest MaxRSS of the job's steps times their tasks, in bytes; null over several nodes. */
  memPeak: number | null
  /** The memory allocated (`mem=` of AllocTRES; per task for an array), in bytes. */
  memAlloc: number | null
  /** Run time and time limit, in seconds; `limitS` null when unlimited. */
  elapsedS: number | null
  limitS: number | null
  /** Where the job's output and error logs are, absolute; null when sacct gave none the mod passes on, or the job never ran. */
  logOut: string | null
  logErr: string | null
  /** A step was killed for memory (the job itself may still say FAILED or COMPLETED); missing in jobs stored before. */
  stepOom?: boolean
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
