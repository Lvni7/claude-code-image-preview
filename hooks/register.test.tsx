import { expect, test } from 'claude-code/testing'

const BAND = {
  plugin: 'image-preview',
  component: 'AbovePrompt',
  surface: 'terminal',
  props: {
    hasSurvey: false,
    isCollapsed: false,
    isWorking: false,
    maxRows: 12,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 12 },
    view: {},
  },
} as const

// A whole PNG of one pixel.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
// More base64 than the 2 MiB an Image takes.
const TOO_HEAVY = 'A'.repeat(3_000_000)

const ran = (exitCode: number, stdout = '') => ({
  value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})

// The pasteboard macOS keeps the last drag on: its count goes up at each drag.
type DragBoard = { count: number; paths: string[] }

// The host as the mod's commands see it: `source` says where a new picture
// is, `heavyAt` the sizes at which its PNG is too heavy to draw.
const host =
  (
    source: 'drop' | 'copied file' | 'clipboard' | 'nowhere',
    copies: string[] = [],
    heavyAt: string[] = [],
    board: DragBoard = { count: 0, paths: [] },
  ) =>
  (_: unknown, e: { argv: readonly string[] }) => {
    const [program = '', ...rest] = e.argv
    const script = rest.join(' ')

    if (program === 'mktemp') return ran(0, '/tmp/preview\n')
    if (program === 'cp') return copies.push(rest[0] ?? ''), ran(0)
    if (program === 'sips') return ran(0, '  pixelWidth: 1\n  pixelHeight: 2\n')
    if (script.includes('sips -Z')) return ran(0, heavyAt.includes(rest[3] ?? '') ? TOO_HEAVY : `${PNG}\n`)
    if (script.includes('NSPasteboardNameDrag')) return ran(0, [board.count, ...board.paths].join('\n'))
    if (script.includes('orca-drops')) return ran(source === 'drop' ? 0 : 1)
    if (script.includes('furl')) return source === 'copied file' ? ran(0, '/Users/me/shot 1.png\n') : ran(1)

    return ran(source === 'clipboard' ? 0 : 1)
  }

// The kit raises these two at run time but does not type them on a test's `$` yet.
const prompt = ($: unknown) =>
  ($ as { prompt: Record<'edit' | 'change', (e: unknown) => Promise<unknown>> }).prompt
// A paste or a drop, as the engine reports it: the draft already holds the placeholder.
const pasted = ($: unknown, text: string) =>
  prompt($).change({ text, cursor: text.length, origin: { kind: 'engine' } })

test('a pasted image gets a button, and loses it when deleted from the draft', async ($, on) => {
  on('process.run', host('clipboard'))
  on('prompt.change', (_, e) => ({ text: e.text }))
  on('prompt.edit', (_, e) => ({
    text: e.text.slice(0, e.start) + e.inputText + e.text.slice(e.end),
    cursor: e.start,
  }))

  await pasted($, 'look [Image #1] ')

  let ui = await $.ui.mount(BAND)
  expect(await ui.find({ type: 'Button', key: 'image-1' })).toBeTruthy()
  await ui.unmount()

  // Backspace over the chip: the draft no longer names the image.
  await prompt($).edit({
    origin: { kind: 'composer' },
    text: 'look [Image #1] ',
    cursor: 16,
    start: 5,
    end: 16,
    inputText: '',
  })

  ui = await $.ui.mount(BAND)
  expect(await ui.find({ type: 'Button' })).toBeFalsy()
  await ui.unmount()
})

test('once the prompt is sent, its pictures leave the band', async ($, on) => {
  on('process.run', host('drop'))
  on('prompt.change', (_, e) => ({ text: e.text }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  await pasted($, 'look [Image #1] ')

  let ui = await $.ui.mount(BAND)
  await ui.press({ key: 'image-1' })
  await ui.redraw()
  expect(await ui.find({ type: 'Image' })).toBeTruthy()
  await ui.unmount()

  await $.prompt.submit({ text: 'look [Image #1] ', wait: false, origin: { kind: 'composer' } })

  ui = await $.ui.mount(BAND)
  expect(await ui.find({ type: 'Button' })).toBeFalsy()
  expect(await ui.find({ type: 'Image' })).toBeFalsy()
  await ui.unmount()
})

test('a prompt recalled from the history gets no button, even once edited', async ($, on) => {
  const copies: string[] = []
  on('process.run', host('copied file', copies))
  on('prompt.change', (_, e) => ({ text: e.text }))
  on('prompt.edit', (_, e) => ({
    text: e.text.slice(0, e.start) + e.inputText + e.text.slice(e.end),
    cursor: e.start + e.inputText.length,
  }))

  await prompt($).change({ text: 'look [Image #1] ', cursor: 16, origin: { kind: 'history' } })
  await prompt($).edit({ origin: { kind: 'composer' }, text: 'look [Image #1] ', cursor: 16, start: 16, end: 16, inputText: '!' })

  expect(copies).toEqual([])
  const ui = await $.ui.mount(BAND)
  expect(await ui.find({ type: 'Button' })).toBeFalsy()
  await ui.unmount()
})

test('an image dragged from the Finder is read from its own file', async ($, on) => {
  const copies: string[] = []
  const board = { count: 5, paths: ['/Users/me/old.png'] }
  on('process.run', host('nowhere', copies, [], board))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.change', (_, e) => ({ text: e.text }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  // Orca pastes the file's own path, which Claude Code turns into the placeholder.
  board.count = 6
  board.paths = ['/Users/me/photo 6K.png', '/Users/me/notes.txt']
  await pasted($, '[Image #1] ')

  expect(copies).toEqual(['/Users/me/photo 6K.png'])
  const ui = await $.ui.mount(BAND)
  expect(await ui.find({ type: 'Button', key: 'image-1' })).toBeTruthy()
  await ui.unmount()
})

test('an image pasted after an older drag is not taken for that drag', async ($, on) => {
  const copies: string[] = []
  on('process.run', host('clipboard', copies, [], { count: 5, paths: ['/Users/me/old.png'] }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.change', (_, e) => ({ text: e.text }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  await pasted($, '[Image #1] ')

  expect(copies).toEqual([])
  const ui = await $.ui.mount(BAND)
  expect(await ui.find({ type: 'Button', key: 'image-1' })).toBeTruthy()
  await ui.unmount()
})

test('a copied file is read itself, never its clipboard icon', async ($, on) => {
  const copies: string[] = []
  on('process.run', host('copied file', copies))
  on('prompt.change', (_, e) => ({ text: e.text }))

  await pasted($, '[Image #1] ')

  expect(copies).toEqual(['/Users/me/shot 1.png'])
})

test('a picture found nowhere gets no button', async ($, on) => {
  on('process.run', host('nowhere'))
  on('prompt.change', (_, e) => ({ text: e.text }))

  await pasted($, '[Image #1] ')

  const ui = await $.ui.mount(BAND)
  expect(await ui.find({ type: 'Button' })).toBeFalsy()
  await ui.unmount()
})

test('a press draws the picture under the buttons, a second press hides it', async ($, on) => {
  on('process.run', host('drop'))
  on('prompt.change', (_, e) => ({ text: e.text }))
  await pasted($, '[Image #1] ')

  const ui = await $.ui.mount(BAND)
  expect(await ui.find({ type: 'Image' })).toBeFalsy()

  await ui.press({ key: 'image-1' })
  await ui.redraw()
  expect((await ui.find({ type: 'Image' }))?.props).toMatchObject({ columns: 1, rows: 1, source: { png: PNG } })

  await ui.press({ key: 'image-1' })
  await ui.redraw()
  expect(await ui.find({ type: 'Image' })).toBeFalsy()
  await ui.unmount()
})

test('a picture too heavy at 640 pixels is drawn smaller, one too heavy at any size is not drawn', async ($, on) => {
  const heavyAt = ['640']
  on('process.run', host('drop', [], heavyAt))
  on('prompt.change', (_, e) => ({ text: e.text }))
  on('ui.toast', () => ({ value: undefined }))
  await pasted($, '[Image #1] ')

  const ui = await $.ui.mount(BAND)
  await ui.press({ key: 'image-1' })
  await ui.redraw()
  expect((await ui.find({ type: 'Image' }))?.props).toMatchObject({ source: { png: PNG } })

  await ui.press({ key: 'image-1' })
  heavyAt.push('320')
  await ui.press({ key: 'image-1' })
  await ui.redraw()
  expect(await ui.find({ type: 'Image' })).toBeFalsy()
  await ui.unmount()
})
