import { describe, expect, mock, test } from 'claude-code/testing'

import { merge3, unifiedDiff } from '../hooks/diff'

describe('unifiedDiff', () => {
  test('one changed line with context', async () => {
    const before = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].join('\n') + '\n'
    const after = before.replace('d\n', 'D\n')
    const diff = unifiedDiff(before, after)
    expect(diff.added).toBe(1)
    expect(diff.removed).toBe(1)
    expect(diff.text).toBe(['@@ -1,7 +1,7 @@', ' a', ' b', ' c', '-d', '+D', ' e', ' f', ' g'].join('\n'))
  })

  test('added and deleted files', async () => {
    expect(unifiedDiff(null, 'x\ny\n')).toEqual({ text: '@@ -0,0 +1,2 @@\n+x\n+y', added: 2, removed: 0 })
    expect(unifiedDiff('x\n', null)).toEqual({ text: '@@ -1,1 +0,0 @@\n-x', added: 0, removed: 1 })
  })

  test('unchanged text has no hunks', async () => {
    expect(unifiedDiff('same\n', 'same\n').text).toBe('')
  })
})

describe('merge3', () => {
  const base = 'a\nb\nc\nd\ne\nf\ng\n'
  test('takes both sides when they touch separate lines', async () => {
    const ours = base.replace('b\n', 'B\n')
    const theirs = base.replace('f\n', 'F\n')
    expect(merge3(base, ours, theirs)).toBe('a\nB\nc\nd\ne\nF\ng\n')
  })
  test('conflicts when both sides change the same line differently', async () => {
    expect(merge3(base, base.replace('d\n', 'X\n'), base.replace('d\n', 'Y\n'))).toBeUndefined()
  })
  test('one side unchanged yields the other', async () => {
    expect(merge3(base, base, base.replace('a\n', ''))).toBe(base.replace('a\n', ''))
  })
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: tracks Write calls in the pane and Clear resets them`, async ($, on) => {
    // A fake file system beneath the plugin.
    const files = new Map([['/repo/a.txt', 'old\n']])
    let tick = 0
    const answer = <T,>(path: string, of: (found: string) => T) => {
      const found = files.get(path)
      return (found === undefined ? { deny: `ENOENT: ${path}` } : { value: of(found) }) as never
    }
    on('fs.stat', ($, e) => answer(e.path, found => ({ kind: 'file', size: found.length, mtimeMs: ++tick, isLink: false })))
    on('fs.read', ($, e) => answer(e.path, found => found))
    on('tool.call', ($, e) => {
      const input = e as unknown as { file_path: string; content: string }
      files.set(input.file_path, input.content)
      return { result: {}, text: 'ok' } as never
    })

    await $.tool.call({ tool: 'Write', file_path: '/repo/a.txt', content: 'new\n' })
    await $.tool.call({ tool: 'Write', file_path: '/repo/b.txt', content: 'hi\n' })

    const ui = await $.ui.mount({
      plugin: 'change-monitor',
      surface,
      component: 'Pane',
      requestId: 'change-monitor',
      props: { title: 'Changes', isFocused: false, bodyColumns: 80, placement: 'dock' } as never,
    })
    expect(await ui.find({ key: 'toggle:/repo/a.txt' })).toBeDefined()
    expect(await ui.find({ key: 'toggle:/repo/b.txt' })).toBeDefined()
    expect(await ui.find({ text: 'No changes since the last Clear.' })).toBeUndefined()

    await ui.press({ key: 'clear' })
    expect(await ui.find({ key: 'toggle:/repo/a.txt' })).toBeUndefined()
    expect(await ui.find({ text: 'No changes since the last Clear.' })).toBeDefined()

    // After Clear the current content is the new baseline.
    await $.tool.call({ tool: 'Write', file_path: '/repo/a.txt', content: 'newer\n' })
    expect(await ui.find({ key: 'toggle:/repo/a.txt' })).toBeDefined()
    expect(await ui.find({ key: 'toggle:/repo/b.txt' })).toBeUndefined()
  })
}

test('an outside edit between tool calls stays out of the diff', async ($, on) => {
  const files = new Map([['/repo/a.txt', 'l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\n']])
  let tick = 0
  const answer = <T,>(path: string, of: (found: string) => T) => {
    const found = files.get(path)
    return (found === undefined ? { deny: `ENOENT: ${path}` } : { value: of(found) }) as never
  }
  on('fs.stat', ($, e) => answer(e.path, found => ({ kind: 'file', size: found.length, mtimeMs: ++tick, isLink: false })))
  on('fs.read', ($, e) => answer(e.path, found => found))
  on('tool.call', ($, e) => {
    const input = e as unknown as { file_path: string; content: string }
    files.set(input.file_path, input.content)
    return { result: {}, text: 'ok' } as never
  })
  const row = async () => {
    const ui = await $.ui.mount({
      plugin: 'change-monitor',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'change-monitor',
      props: { title: 'Changes', isFocused: false, bodyColumns: 80, placement: 'dock' } as never,
    })
    const text = (await ui.find({ key: 'toggle:/repo/a.txt' }))?.text ?? ''
    await ui.unmount()
    return text
  }

  // Claude changes l2.
  await $.tool.call({ tool: 'Write', file_path: '/repo/a.txt', content: 'l1\nL2\nl3\nl4\nl5\nl6\nl7\nl8\n' })
  // The person changes l7 in their editor.
  files.set('/repo/a.txt', 'l1\nL2\nl3\nl4\nl5\nl6\nL7\nl8\n')
  // Claude touches the file again (no further change).
  await $.tool.call({ tool: 'Write', file_path: '/repo/a.txt', content: 'l1\nL2\nl3\nl4\nl5\nl6\nL7\nl8\n' })

  // Only Claude's l2 counts: +1 -1, not +2 -2.
  expect(await row()).toContain('+1 -1')
  expect(await row()).not.toContain('mixed')

  // The person rewrites Claude's own line: cannot be separated.
  files.set('/repo/a.txt', 'l1\nMINE\nl3\nl4\nl5\nl6\nL7\nl8\n')
  await $.tool.call({ tool: 'Write', file_path: '/repo/a.txt', content: 'l1\nMINE\nl3\nl4\nl5\nl6\nL7\nl8\n' })
  expect(await row()).toContain('mixed')
})

test('Off stops tracking, shows the notice and closes the pane after 3 seconds', async ($, on) => {
  const clock = mock.clock(on)
  const files = new Map([['/repo/a.txt', 'old\n']])
  let tick = 0
  const answer = <T,>(path: string, of: (found: string) => T) => {
    const found = files.get(path)
    return (found === undefined ? { deny: `ENOENT: ${path}` } : { value: of(found) }) as never
  }
  on('fs.stat', ($, e) => answer(e.path, found => ({ kind: 'file', size: found.length, mtimeMs: ++tick, isLink: false })))
  on('fs.read', ($, e) => answer(e.path, found => found))
  on('tool.call', ($, e) => {
    const input = e as unknown as { file_path: string; content: string }
    files.set(input.file_path, input.content)
    return { result: {}, text: 'ok' } as never
  })
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  const closed: string[] = []
  on('ui.close', ($, e) => {
    closed.push(e.id)
    return { value: undefined } as never
  })

  await $.tool.call({ tool: 'Write', file_path: '/repo/a.txt', content: 'new\n' })
  const ui = await $.ui.mount({
    plugin: 'change-monitor',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'change-monitor',
    props: { title: 'Changes', isFocused: false, bodyColumns: 80, placement: 'dock' } as never,
  })
  expect(await ui.find({ key: 'toggle:/repo/a.txt' })).toBeDefined()

  await ui.press({ key: 'off' })
  expect(await ui.find({ text: 'change-monitor is off.' })).toBeDefined()
  expect(await ui.find({ text: '/changes on' })).toBeDefined()

  // Tracking is off: a write now is not recorded.
  await $.tool.call({ tool: 'Write', file_path: '/repo/a.txt', content: 'newer\n' })

  expect(closed).toEqual([])
  await clock.advance(3000)
  expect(closed).toEqual(['change-monitor'])
  await ui.unmount()

  // Back on: the current state is the baseline.
  const turnedOn = (await $.command.run({ command: 'changes', args: 'on' } as never)) as { text?: string }
  expect(turnedOn.text).toContain('turned on')
  await $.tool.call({ tool: 'Write', file_path: '/repo/b.txt', content: 'hi\n' })
  const again = await $.ui.mount({
    plugin: 'change-monitor',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'change-monitor',
    props: { title: 'Changes', isFocused: false, bodyColumns: 80, placement: 'dock' } as never,
  })
  expect(await again.find({ key: 'toggle:/repo/a.txt' })).toBeUndefined()
  expect(await again.find({ key: 'toggle:/repo/b.txt' })).toBeDefined()
})
