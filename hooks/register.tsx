import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

const dirAtom = atom({ plugin: 'image-preview', key: 'dir' } as const, null)
const images = atom({ plugin: 'image-preview', key: 'images' } as const, [])
const preview = atom({ plugin: 'image-preview', key: 'preview' } as const, null)

// The PNG the preview draws, base64. Kept out of the state, which only says
// which image shows and how big.
let picture: { n: number; png: string } | null = null

// Every [Image #N] of a text, in order.
const refs = (text: string) =>
  [...text.matchAll(/\[Image #(\d+)\]/g)].map(m => Number(m[1]))

const IMAGE_FILE = /\.(png|jpe?g|gif|webp|heic|bmp|tiff?)$/i

// Copies the file Orca just received by drag-and-drop to "$1": it keeps each
// drop in a folder of its own under $TMPDIR/orca-drops-<uid>.
const COPY_FRESH_DROP = `
d=$(ls -td "\${TMPDIR%/}/orca-drops-$(id -u)"/*/ 2>/dev/null | head -1)
[ -n "$d" ] && [ -n "$(find "$d" -maxdepth 0 -mtime -10s)" ] && cp "$d"/* "$1"`

// The pasteboard macOS keeps the last drag on: its count, which goes up at
// each drag, then the path of each file dragged. A file dragged from the
// Finder onto Orca is pasted as its own path, never copied anywhere.
const READ_DRAG = [
  'ObjC.import("AppKit")',
  'const pb = $.NSPasteboard.pasteboardWithName($.NSPasteboardNameDrag)',
  'const urls = pb.readObjectsForClassesOptions($([$.NSURL]), $({}))',
  'const lines = [pb.changeCount]',
  'if (urls) for (let i = 0; i < urls.count; i++) if (urls.objectAtIndex(i).isFileURL) lines.push(urls.objectAtIndex(i).path.js)',
  'lines.join("\\n")',
].join('\n')

// The drag count last looked at, and the images of that drag not shown yet.
let dragSeen = -1
let dragged: string[] = []

// A drag made since the last look replaces the images waiting to be shown.
const lookAtDrag = async ($: EngineInterface) => {
  const made = await $.process.run(['osascript', '-l', 'JavaScript', '-e', READ_DRAG])
  const [count, ...paths] = made.stdout.trim().split('\n')
  if (made.exitCode !== 0 || Number(count) === dragSeen) return
  dragSeen = Number(count)
  dragged = paths.filter(path => IMAGE_FILE.test(path))
}

// Writes the clipboard's picture to the path given as argv.
const CLIPBOARD_TO_FILE = [
  'on run {p}',
  'try',
  'set d to the clipboard as «class PNGf»',
  'on error',
  'set d to the clipboard as TIFF picture',
  'end try',
  'set f to open for access POSIX file p with write permission',
  'set eof f to 0',
  'write d to f',
  'close access f',
  'end run',
].flatMap(line => ['-e', line])

// An `Image` takes a PNG of at most 2 MiB, here as base64.
const MAX_PNG_BASE64 = Math.floor((2 * 1024 * 1024 * 4) / 3)

const folder = async ($: EngineInterface) => {
  const known = await read($, dirAtom)
  if (known) return known
  const made = await $.process.run(['mktemp', '-d', '-t', 'claude-image-preview'])
  const dir = made.stdout.trim()
  await update($, dirAtom, () => dir)
  return dir
}

const add = ($: EngineInterface, n: number) =>
  update($, images, list => (list.includes(n) ? list : [...list, n].sort((a, b) => a - b)))

// Before sending, Claude Code hands a mod no bytes and no path (the draft only
// gains "[Image #N]"), so the picture is fetched from where it came: the file
// Orca just saved from a drop, a file just dragged from the Finder, the file
// copied in the Finder, else the picture on the clipboard (a screenshot). A
// copied file's own clipboard picture is its icon, so the file is read instead.
// ponytail: Orca and macOS only.
const capture = async ($: EngineInterface, file: string) => {
  await lookAtDrag($).catch(() => {})
  if ((await $.process.run(['sh', '-c', COPY_FRESH_DROP, 'sh', file])).exitCode === 0) {
    dragged = []
    return true
  }

  const path = dragged.shift()
  if (path && (await $.process.run(['cp', path, file])).exitCode === 0) return true

  const copied = await $.process.run(['osascript', '-e', 'POSIX path of (the clipboard as «class furl»)'])
  if (copied.exitCode === 0) {
    const path = copied.stdout.trim()
    return IMAGE_FILE.test(path) && (await $.process.run(['cp', path, file])).exitCode === 0
  }

  return (await $.process.run(['osascript', ...CLIPBOARD_TO_FILE, file])).exitCode === 0
}

// The band holds the draft's pictures only: one is captured for each image of
// `fresh` (just pasted or dropped), and dropped once deleted from the draft.
const sync = async ($: EngineInterface, text: string, fresh: number[]) => {
  const known = await read($, images)
  if (known.length === 0 && fresh.length === 0) return

  for (const n of fresh) {
    if (known.includes(n)) continue
    if (await capture($, `${await folder($)}/${n}.png`)) await add($, n)
  }

  const drafted = refs(text)
  const gone = known.filter(n => !drafted.includes(n))
  if (gone.length === 0) return
  await update($, images, list => list.filter(n => !gone.includes(n)))
  await update($, preview, shown => (shown && gone.includes(shown.n) ? null : shown))
}

type Room = { columns: number; rows: number }

// Draws image `n` under the buttons, scaled to fit `room`. The file is named
// .png whatever it holds (JPEG, HEIC, GIF, ...): sips reads it by its content.
const show = async ($: EngineInterface, n: number, room: Room) => {
  const dir = await folder($)
  const file = `${dir}/${n}.png`
  const size = await $.process.run(['sips', '-g', 'pixelWidth', '-g', 'pixelHeight', file])
  const width = Number(size.stdout.match(/pixelWidth: (\d+)/)?.[1])
  const height = Number(size.stdout.match(/pixelHeight: (\d+)/)?.[1])
  if (!width || !height) return $.ui.toast(`Image #${n} could not be read`)

  // A cell is about twice as tall as wide.
  const scale = Math.min(room.columns / width, (room.rows * 2) / height, 1)
  const columns = Math.max(1, Math.round(width * scale))
  const rows = Math.max(1, Math.round((height * scale) / 2))

  // 640 pixels is sharp at this size on a Retina screen; the rare picture
  // still too heavy for an `Image` (16 bits a channel, noise) is sent smaller.
  for (const side of ['640', '320']) {
    const made = await $.process.run([
      'sh',
      '-c',
      'sips -Z "$1" -s format png "$2" --out "$3" >/dev/null && base64 -i "$3"',
      'sh',
      side,
      file,
      `${dir}/preview.png`,
    ])
    const png = made.stdout.trim()
    if (made.exitCode !== 0 || !png) break
    if (png.length > MAX_PNG_BASE64) continue

    picture = { n, png }
    return update($, preview, () => ({ n, columns, rows }))
  }

  return $.ui.toast(`Image #${n} could not be read`)
}

// A press on an image's button: shows it, or hides it if it is the one showing.
const toggle = async ($: EngineInterface, n: number, room: Room) => {
  if ((await read($, preview))?.n === n && picture?.n === n) return update($, preview, () => null)
  await show($, n, room)
}

export const register: Register = on => {
  // A drag made before the session is not one to show.
  on('session.start', async ($, e, next) => {
    await lookAtDrag($).catch(() => {})
    dragged = []
    return next(e)
  })

  // A paste or a drop reaches the draft as a `prompt.change`, a deletion of
  // its "[Image #N]" as a `prompt.edit`. Only an image the edit itself brought
  // is captured: one already there is a recalled prompt's, sent long ago.
  on('prompt.edit', async ($, e, next) => {
    const box = await next(e)
    const before = refs(e.text)
    await sync($, box.text, refs(box.text).filter(n => !before.includes(n))).catch(() => {})
    return box
  })

  // A prompt recalled from the history was sent already: the band ignores it.
  on('prompt.change', async ($, e, next) => {
    if (e.origin.kind !== 'history') await sync($, e.text, refs(e.text)).catch(() => {})
    return next(e)
  })

  // Sent: its pictures are of no more use, the band empties.
  on('prompt.submit', async ($, e, next) => {
    picture = null
    await update($, preview, () => null).catch(() => {})
    await update($, images, () => []).catch(() => {})
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const list = await read($, images)
    if (e.surface !== 'terminal' || e.props.hasSurvey || list.length === 0) return next(e)

    const { Box, Button, Image } = $.ui.resolve(e)
    const shown = await read($, preview)
    // Small on purpose: a real picture stays sharp at this size.
    const room = {
      columns: Math.min(e.props.bodyColumns, 60),
      rows: Math.max(4, Math.min(e.props.maxRows - 2, 12)),
    }

    return (
      <Box flexDirection="column">
        <Box gap={1}>
          {list.slice(-9).map(n => (
            <Button
              key={`image-${n}`}
              label={`🖼 ${n}`}
              hotkey={n < 10 ? String(n) : undefined}
              onPress={() => void toggle($, n, room)}
            />
          ))}
        </Box>
        {shown && picture?.n === shown.n && (
          <Image
            key="preview"
            source={{ png: picture.png }}
            columns={shown.columns}
            rows={shown.rows}
            alt={`Image #${shown.n}: this terminal does not draw images (set CLAUDE_CODE_FORCE_TERMINAL_IMAGES=1 in ~/.claude/settings.json)`}
          />
        )}
      </Box>
    )
  })
}
