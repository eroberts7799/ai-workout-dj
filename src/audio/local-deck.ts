// LocalDeck — a Web Audio dual-deck engine for owned audio files.
// This is what Spotify's single-stream player can never do: real crossfades,
// gapless-feeling loops, sample-accurate cue starts — and now on-beat cuts:
// a transition waits (≤ one beat) for the OUTGOING track's next beat
// boundary, and the incoming entry is advanced by the same wait so its
// musical timeline (and any drop landing) is preserved. Both edges of the
// cut sit on the grid — it reads as mixed, not triggered.
import { nextBeatDelayMs } from '../conductor/beat'

export interface DeckTrackMeta {
  bpm: number | null
  /** Any beat-grid-aligned position in the track (see beatAnchorMs). */
  anchorMs: number
}

export class LocalDeck {
  private ctx: AudioContext | null = null
  private buffers = new Map<string, AudioBuffer>()
  private meta = new Map<string, DeckTrackMeta>()
  private current: {
    src: AudioBufferSourceNode
    gain: GainNode
    trackId: string
    positionAtMs: number
    startedAtCtx: number
  } | null = null

  private ensureCtx(): AudioContext {
    this.ctx ??= new AudioContext()
    return this.ctx
  }

  has(trackId: string): boolean {
    return this.buffers.has(trackId)
  }

  async load(trackId: string, data: ArrayBuffer): Promise<void> {
    const buf = await this.ensureCtx().decodeAudioData(data)
    this.buffers.set(trackId, buf)
  }

  setMeta(trackId: string, meta: DeckTrackMeta): void {
    this.meta.set(trackId, meta)
  }

  /** Playhead of the active track right now, ms (null when nothing plays). */
  playheadMs(): number | null {
    if (!this.ctx || !this.current) return null
    return this.current.positionAtMs + (this.ctx.currentTime - this.current.startedAtCtx) * 1000
  }

  /**
   * Start trackId at positionMs, crossfading out whatever is playing.
   * fadeSec ~0.8 feels like a radio DJ; loop-backs use a shorter fade so the
   * groove re-entry reads as a cut, not a wash. With onBeat, the cut is
   * deferred to the outgoing track's next beat boundary (needs its meta).
   */
  play(trackId: string, positionMs: number, fadeSec = 0.8, opts: { onBeat?: boolean } = {}): void {
    const ctx = this.ensureCtx()
    void ctx.resume()
    const buf = this.buffers.get(trackId)
    if (!buf) throw new Error(`no local audio for ${trackId}`)

    let delayMs = 0
    if (opts.onBeat && this.current) {
      const m = this.meta.get(this.current.trackId)
      const pos = this.playheadMs()
      if (m?.bpm && pos != null) delayMs = nextBeatDelayMs(pos, m.bpm, m.anchorMs)
    }
    const now = ctx.currentTime
    const t = now + delayMs / 1000
    // The incoming track enters later by the same wait — its timeline holds.
    const startPosMs = Math.max(0, positionMs + delayMs)

    const src = ctx.createBufferSource()
    src.buffer = buf
    const gain = ctx.createGain()
    src.connect(gain)
    gain.connect(ctx.destination)
    gain.gain.setValueAtTime(0.0001, t)
    gain.gain.exponentialRampToValueAtTime(1, t + fadeSec)
    src.start(t, startPosMs / 1000)

    if (this.current) {
      const old = this.current
      const held = Math.max(old.gain.gain.value, 0.0001)
      old.gain.gain.cancelScheduledValues(now)
      old.gain.gain.setValueAtTime(held, now)
      old.gain.gain.setValueAtTime(held, t) // stay full until the cut moment
      old.gain.gain.exponentialRampToValueAtTime(0.0001, t + fadeSec)
      old.src.stop(t + fadeSec + 0.1)
    }
    this.current = { src, gain, trackId, positionAtMs: startPosMs, startedAtCtx: t }
  }

  async pause(): Promise<void> {
    if (this.ctx) await this.ctx.suspend()
  }

  async resume(): Promise<void> {
    if (this.ctx) await this.ctx.resume()
  }

  /** Fade out and stop everything (session end). */
  stop(fadeSec = 0.5): void {
    if (!this.ctx || !this.current) return
    const t = this.ctx.currentTime
    const { gain, src } = this.current
    gain.gain.cancelScheduledValues(t)
    gain.gain.setValueAtTime(Math.max(gain.gain.value, 0.0001), t)
    gain.gain.exponentialRampToValueAtTime(0.0001, t + fadeSec)
    src.stop(t + fadeSec + 0.1)
    this.current = null
  }
}
