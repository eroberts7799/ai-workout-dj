import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../auth/spotify-auth'
import type { SdkHandle } from '../spike/sdk-path'
import { playTrack } from '../spike/webapi-path'
import { deleteTags, downloadTagsFile, importTagsFile, loadAllTags, saveTags } from './store'
import { listAudioTrackIds, saveAudio } from '../audio/local-store'
import { MARKER_LABEL, type Marker, type MarkerType, type SongTags } from './types'

function normalizeTitle(s: string): string {
  return s
    .toLowerCase()
    .replace(/\.(m4a|mp3|wav|flac|aac)$/, '')
    .replace(/^\d+[\s.\-_]*/, '') // strip leading track numbers
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

interface AnalysisEntry {
  sourceFile: string
  title: string
  artist: string
  durationMs: number
  bpm: number | null
  camelot?: string | null
  markers: { type: MarkerType; ms: number }[]
}

// Keypress markers are placed REACTION_OFFSET early to compensate human reaction
// time; the ±nudge + audition loop is the real accuracy mechanism (design doc).
const REACTION_OFFSET_MS = 200
const NUDGE_MS = 50

function fmt(ms: number): string {
  const m = Math.floor(ms / 60_000)
  const s = Math.floor((ms % 60_000) / 1000)
  const frac = Math.floor(ms % 1000)
  return `${m}:${String(s).padStart(2, '0')}.${String(frac).padStart(3, '0')}`
}

function parseTrackId(input: string): string | null {
  const m = input.match(/track[:/]([A-Za-z0-9]{22})/)
  return m ? m[1] : null
}

export default function TagEditor({ sdk }: { sdk: SdkHandle }) {
  const [uriInput, setUriInput] = useState('')
  const [tags, setTags] = useState<SongTags | null>(null)
  const [pos, setPos] = useState(0)
  const [paused, setPaused] = useState(true)
  const [taps, setTaps] = useState<number[]>([])
  const [status, setStatus] = useState('Load a track, then tag with B (buildup), D (drop), L (loop bounds), T (tap tempo), Space (play/pause), ←/→ (±2s, Shift ±0.2s)')
  const [library, setLibrary] = useState(loadAllTags())
  const [localIds, setLocalIds] = useState<Set<string>>(new Set())
  const tagsRef = useRef<SongTags | null>(null)
  tagsRef.current = tags
  const posRef = useRef(0)
  posRef.current = pos

  useEffect(() => {
    void listAudioTrackIds().then((ids) => setLocalIds(new Set(ids)))
  }, [])

  /** Attach owned audio files: match by filename against library titles.
   *  Word-boundary matches outrank substrings (so "ten" can't steal
   *  TENTEN's file), and the longest matching title wins ties. */
  async function attachAudioFiles(files: FileList) {
    const lib = Object.values(loadAllTags())
    const notes: string[] = []
    const all = Array.from(files)
    for (const [i, file] of all.entries()) {
      setStatus(`💾 attaching ${i + 1}/${all.length}: ${file.name} …`)
      const fname = normalizeTitle(file.name)
      let hit: SongTags | null = null
      let bestScore = 0
      for (const s of lib) {
        const title = normalizeTitle(s.name)
        if (!title) continue
        const boundary = new RegExp(`(^| )${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}( |$)`)
        const score = boundary.test(fname) ? 2 + title.length / 1000 : fname.includes(title) || title.includes(fname) ? 1 + title.length / 1000 : 0
        if (score > bestScore) {
          bestScore = score
          hit = s
        }
      }
      if (!hit) {
        notes.push(`✗ ${file.name} — no matching song in the library`)
        continue
      }
      await saveAudio(hit.trackId, file)
      notes.push(`🎧 ${hit.name} — local audio attached`)
    }
    setLocalIds(new Set(await listAudioTrackIds()))
    setStatus(notes.join(' · '))
  }

  // Poll the local player for the playhead — SDK path only, low staleness.
  useEffect(() => {
    const t = setInterval(async () => {
      const s = await sdk.player.getCurrentState()
      if (s) {
        setPos(s.position)
        setPaused(s.paused)
      }
    }, 100)
    return () => clearInterval(t)
  }, [sdk])

  function mutate(fn: (t: SongTags) => SongTags) {
    setTags((prev) => {
      if (!prev) return prev
      const next = fn(prev)
      saveTags(next)
      setLibrary(loadAllTags())
      return next
    })
  }

  async function loadTrack(input: string) {
    const trackId = parseTrackId(input)
    if (!trackId) {
      setStatus('Could not parse a track ID — paste a spotify:track:… URI or an open.spotify.com/track/… link')
      return
    }
    try {
      const res = await api(`/tracks/${trackId}`)
      if (!res.ok) throw new Error(`track lookup: ${res.status}`)
      const t = (await res.json()) as {
        name: string
        duration_ms: number
        artists: { name: string }[]
        uri: string
      }
      const existing = loadAllTags()[trackId]
      const next: SongTags = existing ?? {
        trackId,
        uri: t.uri,
        name: t.name,
        artists: t.artists.map((a) => a.name).join(', '),
        durationMs: t.duration_ms,
        bpm: null,
        markers: [],
        updatedAt: new Date().toISOString(),
      }
      setTags(next)
      saveTags(next)
      setLibrary(loadAllTags())
      await playTrack(sdk.deviceId, t.uri, 0)
      setStatus(`Loaded "${t.name}" — ${existing ? `${existing.markers.length} existing markers` : 'untagged'}`)
    } catch (e) {
      setStatus(String(e))
    }
  }

  function addMarker(type: MarkerType) {
    const at = Math.max(0, posRef.current - REACTION_OFFSET_MS)
    mutate((t) => ({
      ...t,
      markers: [...t.markers, { id: crypto.randomUUID(), type, ms: Math.round(at) }],
    }))
  }

  // Keyboard controls.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = e.target as HTMLElement
      if (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA') return
      if (!tagsRef.current) return
      switch (e.key.toLowerCase()) {
        case 'b':
          addMarker('buildup')
          break
        case 'd':
          addMarker('drop')
          break
        case 'l': {
          const loops = tagsRef.current.markers.filter((m) => m.type.startsWith('loop_'))
          const last = loops.sort((a, b) => a.ms - b.ms)[loops.length - 1]
          addMarker(!last || last.type === 'loop_end' ? 'loop_start' : 'loop_end')
          break
        }
        case 't':
          setTaps((prev) => [...prev.slice(-11), performance.now()])
          break
        case ' ':
          e.preventDefault()
          void sdk.player.togglePlay()
          break
        case 'arrowleft':
          e.preventDefault()
          void sdk.player.seek(Math.max(0, posRef.current - (e.shiftKey ? 200 : 2000)))
          break
        case 'arrowright':
          e.preventDefault()
          void sdk.player.seek(posRef.current + (e.shiftKey ? 200 : 2000))
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sdk])

  const tapBpm = useMemo(() => {
    if (taps.length < 4) return null
    const intervals = taps.slice(1).map((t, i) => t - taps[i]).filter((d) => d > 200 && d < 3000)
    if (intervals.length < 3) return null
    const sorted = [...intervals].sort((a, b) => a - b)
    const median = sorted[Math.floor(sorted.length / 2)]
    return Math.round((60_000 / median) * 10) / 10
  }, [taps])

  function snapToGrid() {
    if (!tags?.bpm) return
    const anchor = [...tags.markers].filter((m) => m.type === 'drop').sort((a, b) => a.ms - b.ms)[0]
    if (!anchor) {
      setStatus('Grid snap needs a DROP marker as the beat-1 anchor')
      return
    }
    const beat = 60_000 / tags.bpm
    mutate((t) => ({
      ...t,
      markers: t.markers.map((m) =>
        m.id === anchor.id ? m : { ...m, ms: Math.round(anchor.ms + Math.round((m.ms - anchor.ms) / beat) * beat) },
      ),
    }))
    setStatus(`Snapped markers to the ${tags.bpm} BPM grid anchored on the first drop`)
  }

  async function audition(m: Marker) {
    await sdk.player.seek(Math.max(0, m.ms - 2000))
    await sdk.player.resume()
  }

  /** Import analyzer output: match each song to a Spotify track via search, then save. */
  /** Strip label-metadata noise ("(Extended Mix)", "- Original Mix") that
   *  wrecks Spotify search queries. */
  function cleanTitle(t: string): string {
    return t
      .replace(/[([][^)\]]*\b(original mix|extended(\s+mix)?|club edit|mixed|remaster[^)\]]*)\b[^)\]]*[)\]]/gi, '')
      .replace(/-\s*(original mix|extended mix|club edit)\s*$/gi, '')
      .replace(/\s+/g, ' ')
      .trim()
  }

  async function importAnalysis(file: File) {
    const parsed = JSON.parse(await file.text()) as { analysis?: AnalysisEntry[] }
    const entries = parsed.analysis ?? []
    if (entries.length === 0) {
      setStatus('No analysis entries in that file — is it analyze.py output?')
      return
    }
    type SpotifyHit = { id: string; uri: string; name: string; duration_ms: number; artists: { name: string }[] }
    const notes: string[] = []
    for (const [i, e] of entries.entries()) {
      setStatus(`🔎 matching ${i + 1}/${entries.length}: ${e.title} …`)
      try {
        // Three attempts, strict → loose; best hit = closest duration.
        const title = cleanTitle(e.title)
        const artist = (e.artist ?? '').split(',')[0].trim()
        const queries = [
          `track:"${title}" artist:"${artist}"`,
          `${title} ${artist}`,
          title,
        ]
        let hit: SpotifyHit | null = null
        for (const q of queries) {
          const res = await api(`/search?q=${encodeURIComponent(q)}&type=track&limit=5`)
          if (!res.ok) continue
          const json = (await res.json()) as { tracks: { items: SpotifyHit[] } }
          const items = json.tracks.items
          if (items.length === 0) continue
          const best = items.reduce((a, b) =>
            Math.abs(a.duration_ms - e.durationMs) <= Math.abs(b.duration_ms - e.durationMs) ? a : b,
          )
          if (!hit || Math.abs(best.duration_ms - e.durationMs) < Math.abs(hit.duration_ms - e.durationMs)) hit = best
          if (hit && Math.abs(hit.duration_ms - e.durationMs) < 5000) break // good enough, stop early
        }
        if (!hit) {
          // The owned-file tier doesn't need Spotify: mint a local identity so
          // the track still joins the crate (deck plays by trackId).
          const slug = `${title} ${artist}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)
          hit = { id: `local-${slug}`, uri: `local:${slug}`, name: title, duration_ms: e.durationMs, artists: [{ name: e.artist }] }
          notes.push(`◎ ${title} — no Spotify match, kept as local-only track`)
        }
        const durGap = Math.abs(hit.duration_ms - e.durationMs)
        saveTags({
          trackId: hit.id,
          uri: hit.uri,
          name: hit.name,
          artists: hit.artists.map((a) => a.name).join(', '),
          durationMs: hit.duration_ms,
          bpm: e.bpm ? Math.round(e.bpm * 10) / 10 : null,
          camelot: e.camelot ?? null,
          markers: e.markers.map((m) => ({ id: crypto.randomUUID(), type: m.type, ms: m.ms })),
          updatedAt: new Date().toISOString(),
        })
        notes.push(
          durGap > 3000
            ? `⚠ ${hit.name} — matched, but duration differs by ${(durGap / 1000).toFixed(1)}s (wrong version? audition before trusting)`
            : `✓ ${hit.name} — ${e.markers.length} markers (audition each to verify offset)`,
        )
      } catch (err) {
        notes.push(`✗ ${e.title} — ${String(err)}`)
      }
    }
    setLibrary(loadAllTags())
    setStatus(notes.join(' · '))
  }

  const sortedMarkers = tags ? [...tags.markers].sort((a, b) => a.ms - b.ms) : []
  const taggedSongs = Object.values(library).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))

  return (
    <>
      <div className="card">
        <h2 style={{ marginTop: 0 }}>Track</h2>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            placeholder="spotify:track:… or open.spotify.com/track/… link"
            value={uriInput}
            onChange={(e) => setUriInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void loadTrack(uriInput)}
          />
          <button onClick={() => void loadTrack(uriInput)}>Load</button>
        </div>
        {tags && (
          <div style={{ marginTop: 12 }}>
            <b>{tags.name}</b> — {tags.artists}
            <div style={{ marginTop: 6 }}>
              <span style={{ fontSize: 22 }}>{fmt(pos)}</span>
              <span className="muted"> / {fmt(tags.durationMs)} {paused ? '⏸' : '▶'}</span>
            </div>
            <input
              type="range"
              min={0}
              max={tags.durationMs}
              value={Math.min(pos, tags.durationMs)}
              onChange={(e) => void sdk.player.seek(Number(e.target.value))}
              style={{ padding: 0, marginTop: 6 }}
            />
            <div style={{ marginTop: 8 }}>
              <button onClick={() => void sdk.player.togglePlay()}>{paused ? 'Play' : 'Pause'} (Space)</button>
              <button onClick={() => addMarker('buildup')}>+ Buildup (B)</button>
              <button onClick={() => addMarker('drop')}>+ Drop (D)</button>
              <button onClick={() => addMarker('loop_start')}>+ Loop ⟨</button>
              <button onClick={() => addMarker('loop_end')}>+ Loop ⟩</button>
            </div>
            <div style={{ marginTop: 8 }}>
              <span className="muted">BPM: </span>
              <b>{tags.bpm ?? '—'}</b>
              {tapBpm && tapBpm !== tags.bpm && (
                <>
                  <span className="muted"> · tapped {tapBpm} </span>
                  <button onClick={() => mutate((t) => ({ ...t, bpm: tapBpm }))}>Set</button>
                </>
              )}
              <span className="muted"> (tap T to the beat) </span>
              <button onClick={snapToGrid} disabled={!tags.bpm}>Snap markers to grid</button>
            </div>
          </div>
        )}
        <p className="muted">{status}</p>
      </div>

      {tags && sortedMarkers.length > 0 && (
        <div className="card">
          <h2 style={{ marginTop: 0 }}>Markers</h2>
          <table>
            <thead>
              <tr><th>type</th><th>at</th><th>adjust</th><th>verify</th><th></th></tr>
            </thead>
            <tbody>
              {sortedMarkers.map((m) => (
                <tr key={m.id}>
                  <td>{MARKER_LABEL[m.type]}</td>
                  <td>{fmt(m.ms)}</td>
                  <td>
                    <button onClick={() => mutate((t) => ({ ...t, markers: t.markers.map((x) => (x.id === m.id ? { ...x, ms: Math.max(0, x.ms - NUDGE_MS) } : x)) }))}>−50ms</button>
                    <button onClick={() => mutate((t) => ({ ...t, markers: t.markers.map((x) => (x.id === m.id ? { ...x, ms: x.ms + NUDGE_MS } : x)) }))}>+50ms</button>
                  </td>
                  <td><button onClick={() => void audition(m)}>▶ −2s</button></td>
                  <td><button onClick={() => mutate((t) => ({ ...t, markers: t.markers.filter((x) => x.id !== m.id) }))}>✕</button></td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted">
            Audition each marker with ▶ −2s: you should hear the moment land exactly 2s in. Nudge until it does.
          </p>
        </div>
      )}

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Tagged library ({taggedSongs.length})</h2>
        {taggedSongs.length === 0 && <p className="muted">Nothing tagged yet. Target: ~10 training songs.</p>}
        {taggedSongs.map((s) => (
          <div key={s.trackId} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
            <span style={{ flex: 1 }}>
              {localIds.has(s.trackId) ? '🎧 ' : ''}{s.name}{' '}
              <span className="muted">— {s.artists} · {s.markers.length} markers{s.bpm ? ` · ${s.bpm} BPM` : ''}</span>
            </span>
            <button onClick={() => { setUriInput(s.uri); void loadTrack(s.uri) }}>Open</button>
            <button onClick={() => { deleteTags(s.trackId); setLibrary(loadAllTags()) }}>✕</button>
          </div>
        ))}
        <div style={{ marginTop: 10 }}>
          <button onClick={downloadTagsFile}>Download tags JSON</button>
          <label style={{ display: 'inline-block', marginRight: 12 }}>
            <span className="muted" style={{ cursor: 'pointer', textDecoration: 'underline' }}>Import tags file</span>
            <input
              type="file"
              accept="application/json"
              style={{ display: 'none' }}
              onChange={async (e) => {
                const f = e.target.files?.[0]
                if (f) {
                  const n = await importTagsFile(f)
                  setLibrary(loadAllTags())
                  setStatus(`Imported ${n} tagged song(s)`)
                }
              }}
            />
          </label>
          <label style={{ display: 'inline-block', marginRight: 12 }}>
            <span className="muted" style={{ cursor: 'pointer', textDecoration: 'underline' }}>Import analysis JSON (auto-tagged)</span>
            <input
              type="file"
              accept="application/json"
              style={{ display: 'none' }}
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) void importAnalysis(f)
              }}
            />
          </label>
          <button
            style={{ marginRight: 12 }}
            title="Deletes every song that has no attached audio file — bad Spotify matches can never receive audio, so this sweeps import junk. Attach your audio FIRST."
            onClick={() => {
              const lib = Object.values(loadAllTags())
              const junk = lib.filter((s) => !localIds.has(s.trackId))
              if (junk.length === 0) return setStatus('nothing to prune — every song has audio')
              if (!confirm(`Delete ${junk.length} song(s) without attached audio?\n\n${junk.map((s) => s.name).join('\n').slice(0, 600)}`)) return
              for (const s of junk) deleteTags(s.trackId)
              setLibrary(loadAllTags())
              setStatus(`🧹 pruned ${junk.length} song(s) without audio`)
            }}
          >
            🧹 Prune songs without audio
          </button>
          <label style={{ display: 'inline-block' }}>
            <span className="muted" style={{ cursor: 'pointer', textDecoration: 'underline' }}>Attach owned audio files (🎧 = real DJ crossfades)</span>
            <input
              type="file"
              accept="audio/*,.m4a"
              multiple
              style={{ display: 'none' }}
              onChange={(e) => {
                if (e.target.files?.length) void attachAudioFiles(e.target.files)
              }}
            />
          </label>
        </div>
      </div>
    </>
  )
}
