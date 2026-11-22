// The N of every [Image #N] saved as <dir>/<N>.png.
export type ImageNumbers = number[]

// The image drawn under the buttons and its size in cells.
export type ImagePreview = { n: number; columns: number; rows: number }

declare module 'claude-code' {
  interface PluginState {
    'image-preview': { dir: string | null; images: ImageNumbers; preview: ImagePreview | null }
  }
}
