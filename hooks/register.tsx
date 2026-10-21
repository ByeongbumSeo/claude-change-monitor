import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Entry } from '../types'
import { merge3, unifiedDiff } from './diff'

const PANE = 'change-monitor'
const TITLE = 'Changes'
const MAX_BYTES = 1_000_000
// Caps on how many dirty files one Bash call inspects.
const MAX_PRE_READ = 100
const MAX_NEW = 200

const entries = atom({ plugin: 'change-monitor', key: 'entries' } as const, {})
const collapsed = atom({ plugin: 'change-monitor', key: 'collapsed' } as const, {})
const root = atom({ plugin: 'change-monitor', key: 'root' } as const, '')

type $ = EngineInterface

let isGit = false
// Pre-Bash reads, reused while a file's mtime and size stay the same.
const readCache = new Map<string, { mtimeMs: number; size: number; text: string }>()

/** The file's text, null when absent, undefined when it cannot be tracked (dir, too large, unreadable). */
async function snapshot($: $, path: string): Promise<string | null | undefined> {
  const stat = await $.fs.stat(path).catch(() => undefined)
  if (stat === undefined) return null
  if (stat.kind !== 'file' || stat.size > MAX_BYTES) return undefined
  const hit = readCache.get(path)
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.text
  const text = await $.fs.read(path).catch(() => undefined)
  if (text !== undefined) readCache.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, text })
  return text
}

/** Starts tracking `path` with `baseline` unless it is tracked already. */
const track = ($: $, path: string, baseline: string | null, current: string | null) =>
  update($, entries, map => (path in map ? map : { ...map, [path]: { baseline, current } }))

async function refresh($: $, path: string) {
  const now = await snapshot($, path)
  if (now === undefined) return
  await update($, entries, map => {
    const entry = map[path]
    return entry === undefined || entry.current === now ? map : { ...map, [path]: { ...entry, current: now } }
  })
}

/**
 * Folds an edit made outside Claude since its last tool call into the baseline,
 * so the diff keeps showing Claude's changes alone; marks the entry mixed when
 * the two cannot be separated.
 */
async function absorbOutside($: $, path: string) {
  const now = await snapshot($, path)
  if (now === undefined) return
  await update($, entries, map => {
    const entry = map[path]
    if (entry === undefined || entry.current === now) return map
    const { baseline, current } = entry
    const merged =
      baseline !== null && current !== null && now !== null ? merge3(current, baseline, now) : undefined
    const next: Entry =
      merged === undefined
        ? { baseline, current: now, isMixed: true }
        : { baseline: merged, current: now, isMixed: entry.isMixed }
    return { ...map, [path]: next }
  })
}

async function absolute($: $, path: string) {
  if (path.startsWith('/')) return path
  return `${(await $.session.cwd()).replace(/\/$/, '')}/${path}`
}

/** Absolute paths `git status` lists as changed or untracked. */
async function dirtyPaths($: $, top: string): Promise<string[]> {
  const run = await $.process.run(
    ['git', '-c', 'core.quotepath=off', 'status', '--porcelain=v1', '-z', '-uall'],
    { cwd: top, timeoutMs: 5000 },
  )
  if (run.exitCode !== 0) return []
  const parts = run.stdout.split('\0')
  const paths: string[] = []
  for (let k = 0; k < parts.length; k++) {
    const part = parts[k]!
    if (part.length < 4) continue
    paths.push(`${top}/${part.slice(3)}`)
    // A rename or copy is followed by its original path.
    if (part[0] === 'R' || part[0] === 'C') k++
  }
  return paths
}

async function headContent($: $, top: string, path: string): Promise<string | null> {
  const rel = path.slice(top.length + 1)
  const run = await $.process.run(['git', 'show', `HEAD:${rel}`], { cwd: top, timeoutMs: 5000 })
  return run.exitCode === 0 && !run.isStdoutTruncated ? run.stdout : null
}

async function beforeBash($: $, top: string) {
  const tracked = await read($, entries)
  for (const path of Object.keys(tracked)) await absorbOutside($, path)
  const before = new Map<string, string | null>()
  const skipped = new Set<string>()
  for (const path of await dirtyPaths($, top)) {
    if (path in tracked) continue
    const text = before.size < MAX_PRE_READ ? await snapshot($, path) : undefined
    if (text === undefined) skipped.add(path)
    else before.set(path, text)
  }
  return { before, skipped }
}

async function afterBash($: $, top: string, pre: { before: Map<string, string | null>; skipped: Set<string> }) {
  const tracked = await read($, entries)
  for (const path of Object.keys(tracked)) await refresh($, path)

  let fresh = 0
  const candidates = new Set([...pre.before.keys(), ...(await dirtyPaths($, top))])
  for (const path of candidates) {
    if (path in tracked || pre.skipped.has(path)) continue
    const isNew = !pre.before.has(path)
    if (isNew && ++fresh > MAX_NEW) continue
    const now = await snapshot($, path)
    if (now === undefined) continue
    const baseline = isNew ? await headContent($, top, path) : pre.before.get(path)!
    if (baseline !== now) await track($, path, baseline, now)
  }
}

function pathOf(e: object): string | undefined {
  const input = e as Record<string, unknown>
  const path = input.file_path ?? input.notebook_path
  return typeof path === 'string' && path !== '' ? path : undefined
}

const kindOf = (entry: Entry): 'A' | 'M' | 'D' | undefined =>
  entry.baseline === entry.current ? undefined
  : entry.baseline === null ? 'A'
  : entry.current === null ? 'D'
  : 'M'

const COLOR = { A: 'success', M: 'warning', D: 'error' } as const

const clear = ($: $) =>
  Promise.all([update($, entries, () => ({})), update($, collapsed, () => ({}))])

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const cwd = await $.session.cwd()
    const top = await $.process
      .run(['git', 'rev-parse', '--show-toplevel'], { cwd, timeoutMs: 5000 })
      .catch(() => undefined)
    isGit = top?.exitCode === 0
    await update($, root, () => (isGit ? top!.stdout.trim() : cwd))

    await $.command.register({
      name: 'changes',
      description: 'Open the Changes pane (/changes clear resets the baseline)',
      argumentHint: '[clear]',
    })
    void $.ui.open({ id: PANE, title: TITLE })

    return next(e)
  })

  on('command.run', { command: 'changes' }, async ($, e) => {
    if (e.args.trim() === 'clear') {
      await clear($)
      return { text: 'Changes cleared: the current state is the new baseline.' }
    }
    await $.ui.open({ id: PANE, title: TITLE })
    return { text: 'Changes pane opened.' }
  })

  on('tool.call', { tool: ['Edit', 'Write', 'NotebookEdit'] }, async ($, e, next) => {
    const raw = pathOf(e)
    let path: string | undefined
    try {
      if (raw !== undefined) {
        path = await absolute($, raw)
        if (path in (await read($, entries))) await absorbOutside($, path)
        else {
          const before = await snapshot($, path)
          if (before !== undefined) await track($, path, before, before)
        }
      }
    } catch {
      path = undefined
    }

    const ran = await next(e)
    if (path !== undefined) await refresh($, path).catch(() => {})
    return ran
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const top = await read($, root)
    const pre = isGit ? await beforeBash($, top).catch(() => undefined) : undefined

    const ran = await next(e)
    if (pre !== undefined) await afterBash($, top, pre).catch(() => {})
    return ran
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Code } = $.ui.resolve(e)
    const [map, folded, top] = await Promise.all([read($, entries), read($, collapsed), read($, root)])

    const files = Object.entries(map)
      .flatMap(([path, entry]) => {
        const kind = kindOf(entry)
        if (kind === undefined) return []
        const rel = path.startsWith(`${top}/`) ? path.slice(top.length + 1) : path
        return [{ path, rel, kind, isMixed: entry.isMixed === true, diff: unifiedDiff(entry.baseline, entry.current) }]
      })
      .sort((a, b) => a.rel.localeCompare(b.rel))

    const added = files.reduce((sum, f) => sum + f.diff.added, 0)
    const removed = files.reduce((sum, f) => sum + f.diff.removed, 0)

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" justifyContent="space-between">
          <Text weight="bold">
            {files.length} files <Text color="diffAdded">+{added}</Text>{' '}
            <Text color="diffRemoved">-{removed}</Text>
          </Text>
          <Button key="clear" hotkey="c" onPress={() => void clear($)}>
            Clear
          </Button>
        </Box>
        {files.length === 0 && <Text dimColor>No changes since the last Clear.</Text>}
        {files.map(f => (
          <Box key={`file:${f.path}`} flexDirection="column">
            <Button
              key={`toggle:${f.path}`}
              plain
              onPress={() => void update($, collapsed, c => ({ ...c, [f.path]: !c[f.path] }))}
            >
              <Text color={COLOR[f.kind]} weight="bold">
                {f.kind}
              </Text>{' '}
              {folded[f.path] ? '▸' : '▾'} {f.rel}{' '}
              <Text dimColor>
                +{f.diff.added} -{f.diff.removed}
              </Text>
              {f.isMixed && <Text color="warning"> ⚠ mixed with outside edits</Text>}
            </Button>
            {!folded[f.path] && f.diff.text !== '' && (
              <Code source={f.diff.text} format="diff" path={f.rel} />
            )}
          </Box>
        ))}
      </Box>
    )
  })
}
