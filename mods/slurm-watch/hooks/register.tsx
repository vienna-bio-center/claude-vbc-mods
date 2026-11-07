import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Backoff, Job, Poll, Via } from '../types'
import {
  ago,
  applyReading,
  cleanName,
  endSummary,
  endText,
  explainFailure,
  findSubmissions,
  hostPatterns,
  isAllowed,
  isFinal,
  isValidVia,
  noteText,
  parseSacct,
  prune,
  sacctArgv,
  statusText,
  tone,
  viaKey,
  viaLabel,
  viaOf,
} from './slurm'

const PANE = 'slurm-watch'
const TITLE = 'Slurm jobs'
/** How often a timer looks whether a poll is due. */
const TICK_MS = 60_000
/** Regular gap between two sacct calls (the cbe-next rule: every few minutes at most). */
const EVERY_MS = 3 * 60_000
/** Shortest gap for an asked-for poll (Refresh, the first look after a submit). */
const MIN_GAP_MS = 60_000
/** The first look after a submit, so the name and state arrive. */
const FIRST_LOOK_MS = 30_000
const SACCT_TIMEOUT_MS = 30_000
/** A host that failed waits 10 minutes, doubling up to an hour. */
const BACKOFF_MS = 10 * 60_000
const BACKOFF_MAX_MS = 60 * 60_000
/** A host failing this long in a row: its jobs are given up as UNKNOWN. */
const GIVE_UP_MS = 48 * 3600_000
/** More jobs than this ending in one poll get one toast and one notification. */
const SINGLE_TOASTS = 3
export const DEFAULT_HOSTS = 'cbe.next, *.vbc.ac.at'

/** One store key per job, so two writers never overwrite each other's jobs. */
const JOB_PREFIX = 'job:'
const STORE_POLL = 'poll'
const NO_POLL: Poll = { lastAt: 0, nextAt: 0, errors: {}, backoff: {} }

const jobsAtom = atom({ plugin: 'slurm-watch', key: 'jobs' } as const, [])
const pollAtom = atom({ plugin: 'slurm-watch', key: 'poll' } as const, NO_POLL)
const nowAtom = atom({ plugin: 'slurm-watch', key: 'now' } as const, 0)

/** The `hosts` setting, read at each (re)load. */
let hosts: string[] = hostPatterns(DEFAULT_HOSTS)
/** A first look already waits: further submits ride on it. */
let firstLookPending = false
/** Everything that reads and writes the store runs one after another in this process. */
let chain: Promise<unknown> = Promise.resolve()

function serial<T>(work: () => Promise<T>): Promise<T> {
  const run = chain.then(work, work)
  chain = run.catch(() => undefined)
  return run
}

const isTracked = (j: Job) => isAllowed(j.via, hosts)

export const jobKey = (j: Pick<Job, 'id' | 'cluster' | 'via'>) => `${viaKey(j.via)}|${j.cluster ?? ''}|${j.id}`

// ── The store: shared by every session, read fresh before every write ────

/** What a job stored by an older version may lack. */
const DEFAULTS = {
  cluster: null,
  name: '',
  elapsed: '',
  exitCode: '',
  tasks: null,
  endedAt: null,
  misses: 0,
  notified: false,
  told: false,
} satisfies Partial<Job>

function asJob(v: unknown): Job | null {
  if (typeof v !== 'object' || v === null) return null
  const j = v as Partial<Job>
  const isJob =
    typeof j.id === 'string' &&
    /^\d{1,12}$/.test(j.id) &&
    typeof j.state === 'string' &&
    typeof j.submittedAt === 'number' &&
    typeof j.owner === 'string' &&
    (j.via === null || isValidVia(j.via))
  return isJob ? { ...DEFAULTS, ...(j as Job) } : null
}

export async function loadJobs($: EngineInterface): Promise<Job[]> {
  const jobs: Job[] = []
  for (const key of await $.store.keys()) {
    if (!key.startsWith(JOB_PREFIX)) continue
    const job = asJob(await $.store.get(key))
    // a value the mod never writes is dropped rather than trusted
    if (job === null || JOB_PREFIX + jobKey(job) !== key) await $.store.delete(key)
    else jobs.push(job)
  }
  return jobs
}

/** Changes one job on a fresh read of it; `null` removes it. Writes only on a change, and says whether it wrote. */
async function patchJob($: EngineInterface, key: string, change: (j: Job) => Job | null): Promise<boolean> {
  const job = asJob(await $.store.get(JOB_PREFIX + key))
  if (job === null) return false
  const next = change(job)
  if (next === null) await $.store.delete(JOB_PREFIX + key)
  else if (JSON.stringify(next) !== JSON.stringify(job)) await $.store.set(JOB_PREFIX + key, next)
  else return false
  return true
}

export async function loadPoll($: EngineInterface): Promise<Poll> {
  const v = (await $.store.get(STORE_POLL)) as Partial<Poll> | undefined
  if (typeof v !== 'object' || v === null) return NO_POLL
  const map = <T,>(m: unknown) => (typeof m === 'object' && m !== null ? (m as Record<string, T>) : {})
  return {
    lastAt: typeof v.lastAt === 'number' ? v.lastAt : 0,
    nextAt: typeof v.nextAt === 'number' ? v.nextAt : 0,
    errors: map<string>(v.errors),
    backoff: map<Backoff>(v.backoff),
  }
}

/** Changes the poll record on a fresh read; writes only on a change. */
async function patchPoll($: EngineInterface, change: (p: Poll) => Poll) {
  const poll = await loadPoll($)
  const next = change(poll)
  if (JSON.stringify(next) !== JSON.stringify(poll)) await $.store.set(STORE_POLL, next)
}

/** The store, as the pane and the status line show it. */
async function show($: EngineInterface) {
  const now = await $.clock.now()
  const jobs = prune(await loadJobs($), now, isTracked)
  const poll = await loadPoll($)
  await update($, jobsAtom, () => jobs)
  await update($, pollAtom, () => poll)
  await update($, nowAtom, () => now)
  $.ui.status(statusText(jobs, Object.keys(poll.errors).length > 0, isTracked))
}

// ── Asking Slurm ─────────────────────────────────────────────────────────

type Group = { via: Via; cluster: string | null; jobs: Job[] }

/** The jobs to ask about, one group per host and cluster: tracked and not ended. */
function groups(jobs: readonly Job[]): Group[] {
  const out = new Map<string, Group>()
  for (const j of jobs) {
    if (j.via === null || isFinal(j.state) || !isTracked(j)) continue
    const key = `${viaKey(j.via)}|${j.cluster ?? ''}`
    const g = out.get(key) ?? { via: j.via, cluster: j.cluster, jobs: [] }
    g.jobs.push(j)
    out.set(key, g)
  }
  return [...out.values()]
}

const pick = <T,>(m: Record<string, T>, keys: ReadonlySet<string>) =>
  Object.fromEntries(Object.entries(m).filter(([k]) => keys.has(k)))

/** One sacct call per host (and cluster) in `todo`. */
async function pollAll($: EngineInterface, todo: Group[], poll: Poll, now: number) {
  const user = await $.env.get('USER')
  const outcome = new Map<string, string | null>()
  for (const g of todo) {
    const key = viaKey(g.via)
    const rest = poll.backoff[key]
    const argv = sacctArgv(g.via, g.jobs.map(j => j.id), g.cluster, user)
    if (argv === null) continue
    const ran = await $.process.run(argv, { timeoutMs: SACCT_TIMEOUT_MS }).catch(() => null)
    let error: string | null = null
    if (ran === null) {
      error =
        g.via.kind === 'local'
          ? 'sacct could not run on this machine. Is Claude running on a cluster login node?'
          : `ssh to ${g.via.host} did not finish in time.`
    } else if (ran.exitCode !== 0) {
      error = explainFailure(g.via, ran.exitCode, ran.stderr)
    } else {
      const rows = parseSacct(ran.stdout)
      for (const j of g.jobs) await patchJob($, jobKey(j), x => applyReading(x, rows.get(x.id), now))
    }
    if (error !== null && rest && now - rest.since >= GIVE_UP_MS) {
      // two days without an answer: the jobs there are given up, not asked about for weeks
      for (const j of g.jobs) {
        await patchJob($, jobKey(j), x => (isFinal(x.state) ? x : { ...x, state: 'UNKNOWN', endedAt: x.endedAt ?? now }))
      }
      error = null
    }
    if (!outcome.has(key) || error !== null) outcome.set(key, error)
  }

  await patchPoll($, p => {
    const errors = { ...p.errors }
    const backoff = { ...p.backoff }
    for (const [key, error] of outcome) {
      if (error === null) {
        delete errors[key]
        delete backoff[key]
        continue
      }
      const before = backoff[key]
      const tries = (before?.tries ?? 0) + 1
      backoff[key] = {
        since: before?.since ?? now,
        tries,
        until: now + Math.min(BACKOFF_MAX_MS, BACKOFF_MS * 2 ** (tries - 1)),
      }
      errors[key] = error
    }
    return { ...p, errors, backoff }
  })
}

// ── Telling the person and Claude ────────────────────────────────────────

async function announce($: EngineInterface, me: string) {
  const jobs = await loadJobs($)
  const toTell = jobs.filter(j => isFinal(j.state) && !j.told && j.owner === me)

  // claimed before it is shown, on a fresh read: the session whose write flips the flag shows it,
  // so another session that saw the end at the same time does not show it again
  const toNotify: Job[] = []
  for (const j of jobs) {
    if (!isFinal(j.state) || j.notified) continue
    if (await patchJob($, jobKey(j), x => (x.notified ? x : { ...x, notified: true }))) toNotify.push(j)
  }
  if (toNotify.length > SINGLE_TOASTS) {
    const text = endSummary(toNotify)
    $.ui.toast(text)
    await $.ui.notify(text, { title: 'Slurm' }).catch(() => undefined)
  } else {
    for (const j of toNotify) {
      $.ui.toast(endText(j))
      await $.ui.notify(endText(j), { title: 'Slurm' }).catch(() => undefined)
    }
  }

  if (toTell.length > 0) {
    // a row at the end of the conversation, read with the next prompt: no turn is started
    const sent = await $.session
      .append({ message: { type: 'user', content: [{ type: 'text', text: noteText(toTell) }] } })
      .then(
        () => true,
        () => false,
      )
    if (sent) for (const j of toTell) await patchJob($, jobKey(j), x => ({ ...x, told: true }))
  }
}

// ── The tick: prune, poll when due, announce, show ───────────────────────

export async function tick($: EngineInterface, asked = false) {
  const now = await $.clock.now()
  // asked each time: /clear and a resume move the session to another id
  const me = await $.session.id()

  const all = await loadJobs($)
  const kept = new Set(prune(all, now, isTracked))
  for (const j of all) if (!kept.has(j)) await $.store.delete(JOB_PREFIX + jobKey(j))
  const jobs = all.filter(j => kept.has(j))

  const poll = await loadPoll($)
  // a host resting after a failure waits out its time, unless the person asked
  const todo = groups(jobs).filter(g => asked || !((poll.backoff[viaKey(g.via)]?.until ?? 0) > now))
  const due = asked ? now - poll.lastAt >= MIN_GAP_MS : now >= poll.nextAt
  if (todo.length > 0 && due) {
    // claim the slot first, so another open session does not ask Slurm too
    await patchPoll($, p => ({ ...p, lastAt: now, nextAt: now + EVERY_MS }))
    await pollAll($, todo, poll, now)
  }

  // a host with nothing left to ask about keeps no error
  const active = new Set(groups(await loadJobs($)).map(g => viaKey(g.via)))
  await patchPoll($, p => ({ ...p, errors: pick(p.errors, active), backoff: pick(p.backoff, active) }))

  await announce($, me)
  await show($)
}

async function record($: EngineInterface, command: string, output: string): Promise<number> {
  const found = findSubmissions(command, output)
  if (found.length === 0) return 0
  const via = viaOf(command)
  const now = await $.clock.now()
  const me = await $.session.id()
  let added = 0
  for (const f of found) {
    const job: Job = {
      id: f.id,
      cluster: f.cluster,
      via,
      name: '',
      state: 'SUBMITTED',
      elapsed: '',
      exitCode: '',
      tasks: null,
      submittedAt: now,
      endedAt: null,
      owner: me,
      misses: 0,
      notified: false,
      told: false,
    }
    const key = JOB_PREFIX + jobKey(job)
    if ((await $.store.get(key)) !== undefined) continue
    await $.store.set(key, job)
    added++
  }
  if (added > 0) await show($)
  return added
}

async function forget($: EngineInterface, key: string) {
  await $.store.delete(JOB_PREFIX + key)
  await show($)
}

async function clearFinished($: EngineInterface) {
  for (const j of await loadJobs($)) {
    if (isFinal(j.state) && j.notified) await $.store.delete(JOB_PREFIX + jobKey(j))
  }
  await show($)
}

// ── Hooks ────────────────────────────────────────────────────────────────

export const register: Register = (on, options) => {
  hosts = hostPatterns(typeof options.hosts === 'string' ? options.hosts : DEFAULT_HOSTS)

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await $.command.register({ name: 'slurm-jobs', description: 'Shows the Slurm jobs Claude submitted and their state' })
    await serial(() => show($))
    // the first look runs after the start, never holding it up with an ssh call
    $.clock.after(1_000, () => void serial(() => tick($)).catch(() => undefined))
    $.clock.every(TICK_MS, () => void serial(() => tick($)).catch(() => undefined))
    return result
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (!ran.text) return ran
    // the display must never touch the tool's own result
    try {
      const added = await serial(() => record($, e.command, ran.text ?? ''))
      if (added > 0 && !firstLookPending) {
        firstLookPending = true
        $.clock.after(FIRST_LOOK_MS, () => {
          firstLookPending = false
          void serial(() => tick($, true)).catch(() => undefined)
        })
      }
    } catch {}
    return ran
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'slurm-jobs' }, async $ => {
    await serial(() => show($))
    await $.ui.open({ id: PANE, title: TITLE })
    return { text: 'Slurm jobs opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const jobs = await read($, jobsAtom)
    const poll = await read($, pollAtom)
    const now = (await read($, nowAtom)) || poll.lastAt
    const cols = e.props.bodyColumns

    if (jobs.length === 0) {
      return <Text dimColor>No Slurm jobs yet. Jobs Claude submits with sbatch show up here.</Text>
    }

    const hasActive = jobs.some(j => !isFinal(j.state) && isTracked(j))
    const checked = poll.lastAt ? `last check ${ago(now - poll.lastAt)} ago` : 'not checked yet'
    const nextCheck = !hasActive
      ? 'nothing left to check'
      : poll.nextAt > now
        ? `next in ${ago(poll.nextAt - now + 59_999)}`
        : 'next within a minute'

    // columns that fit: id, name and state always; time, host, exit and age while there is room
    const idW = Math.min(16, Math.max(6, ...jobs.map(j => j.id.length + (j.cluster ? j.cluster.length + 1 : 0))) + 1)
    const stateW = 14
    let room = cols - idW - stateW - 2 - 12 // 2: the ✕; 12: the name's least
    const fits = (w: number) => (room >= w ? ((room -= w), true) : false)
    const showTime = fits(12)
    const showHost = fits(16)
    const showExit = fits(7)
    const showAge = fits(7)
    const nameW = Math.max(8, 12 + room)
    const cut = (s: string, w: number) => (s.length > w ? `${s.slice(0, Math.max(1, w - 1))}…` : s)
    const stateOf = (j: Job) =>
      !isFinal(j.state) && !isTracked(j) ? 'not checked' : j.state.toLowerCase().replace(/_/g, ' ')

    const sorted = [...jobs].sort(
      (a, b) => Number(isFinal(a.state)) - Number(isFinal(b.state)) || b.submittedAt - a.submittedAt,
    )
    const unchecked = jobs.some(j => !isFinal(j.state) && !isTracked(j))

    return (
      <Box flexDirection="column">
        <Text dimColor>
          {jobs.length} {jobs.length === 1 ? 'job' : 'jobs'} · {checked} · {nextCheck}
        </Text>
        {Object.entries(poll.errors).map(([key, message]) => (
          <Text key={`err-${key}`} color="warning">
            ⚠ {message}
          </Text>
        ))}
        <Box marginTop={1}>
          <Box width={idW}>
            <Text bold>Job</Text>
          </Box>
          <Box width={nameW}>
            <Text bold>Name</Text>
          </Box>
          <Box width={stateW}>
            <Text bold>State</Text>
          </Box>
          {showTime && (
            <Box width={12}>
              <Text bold>Elapsed</Text>
            </Box>
          )}
          {showHost && (
            <Box width={16}>
              <Text bold>Host</Text>
            </Box>
          )}
          {showExit && (
            <Box width={7}>
              <Text bold>Exit</Text>
            </Box>
          )}
          {showAge && (
            <Box width={7}>
              <Text bold>Sent</Text>
            </Box>
          )}
        </Box>
        {sorted.map(j => {
          const key = jobKey(j)
          return (
            <Box key={`row-${key}`}>
              <Box width={idW}>
                <Text wrap="truncate-end">{cut(j.cluster ? `${j.id}@${j.cluster}` : j.id, idW - 1)}</Text>
              </Box>
              <Box width={nameW}>
                <Text wrap="truncate-end">{cut(cleanName(j.name) || '–', nameW - 1)}</Text>
              </Box>
              <Box width={stateW}>
                <Text color={isTracked(j) || isFinal(j.state) ? tone(j.state) : 'inactive'} bold>
                  {cut(stateOf(j), stateW - 1)}
                </Text>
              </Box>
              {showTime && (
                <Box width={12}>
                  <Text dimColor>{j.tasks ? `${j.tasks.done}/${j.tasks.total}` : j.elapsed || '–'}</Text>
                </Box>
              )}
              {showHost && (
                <Box width={16}>
                  <Text dimColor wrap="truncate-end">
                    {cut(viaLabel(j.via), 15)}
                  </Text>
                </Box>
              )}
              {showExit && (
                <Box width={7}>
                  <Text dimColor>{isFinal(j.state) ? j.exitCode || '–' : ''}</Text>
                </Box>
              )}
              {showAge && (
                <Box width={7}>
                  <Text dimColor>{ago(now - j.submittedAt)}</Text>
                </Box>
              )}
              <Button key={`forget-${key}`} label="✕" plain dimColor onPress={() => serial(() => forget($, key))} />
            </Box>
          )
        })}
        {unchecked && (
          <Box marginTop={1}>
            <Text dimColor>
              Not checked: the host is not in the “hosts” setting ({hosts.join(', ') || 'empty'}), or the job was sent in
              a way the mod does not repeat.
            </Text>
          </Box>
        )}
        <Box marginTop={1} columnGap={2}>
          <Button key="refresh" label="Refresh" onPress={() => serial(() => tick($, true))} />
          <Button key="clear" label="Clear finished" onPress={() => serial(() => clearFinished($))} />
        </Box>
        <Text dimColor>Checks Slurm every 3 minutes at most, one sacct call per host.</Text>
      </Box>
    )
  })
}
