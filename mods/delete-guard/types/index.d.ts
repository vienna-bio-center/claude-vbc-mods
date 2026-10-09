/** One thing the command would delete, as the panel lists it. */
export type Entry = {
  /** As shown: relative to the working directory inside it, `~/...` or absolute. */
  path: string
  kind: 'dir' | 'file' | 'link' | 'missing' | 'unknown'
  /** Bytes of a file, or of everything under a folder. */
  size: number
  /** Files and folders under a folder (counted up to a limit: `isPartial`). */
  files: number
  dirs: number
  isPartial: boolean
  /** A few paths inside a folder, relative to it. */
  sample: string[]
  /** Why it is listed this way (`matches nothing`, `decided when the command runs`). */
  note: string
  /** Set when the command cuts the file instead of removing it (`truncate`): what it does to it. */
  change?: string
}

/** A delete waiting for the person's answer. */
export type Request = {
  id: string
  command: string
  cwd: string
  entries: Entry[]
  /** Parts of the command whose targets can't be listed beforehand. */
  notes: string[]
}

declare module 'claude-code' {
  interface PluginState {
    'delete-guard': {
      queue: Request[]
    }
  }
}
