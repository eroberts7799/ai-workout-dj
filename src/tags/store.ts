import type { SongTags } from './types'

const KEY = 'awdj.tags.v1'

export function loadAllTags(): Record<string, SongTags> {
  const raw = localStorage.getItem(KEY)
  return raw ? (JSON.parse(raw) as Record<string, SongTags>) : {}
}

export function saveTags(tags: SongTags): void {
  const all = loadAllTags()
  all[tags.trackId] = { ...tags, updatedAt: new Date().toISOString() }
  localStorage.setItem(KEY, JSON.stringify(all))
}

export function deleteTags(trackId: string): void {
  const all = loadAllTags()
  delete all[trackId]
  localStorage.setItem(KEY, JSON.stringify(all))
}

export function downloadTagsFile(): void {
  const blob = new Blob([JSON.stringify({ version: 1, tags: loadAllTags() }, null, 2)], {
    type: 'application/json',
  })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = 'song-tags.json'
  a.click()
}

export async function importTagsFile(file: File): Promise<number> {
  const parsed = JSON.parse(await file.text()) as { tags?: Record<string, SongTags> }
  const incoming = parsed.tags ?? {}
  const all = loadAllTags()
  let count = 0
  for (const [id, t] of Object.entries(incoming)) {
    all[id] = t
    count++
  }
  localStorage.setItem(KEY, JSON.stringify(all))
  return count
}
