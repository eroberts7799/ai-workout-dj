// LocalDeck — a Web Audio dual-deck engine for owned audio files.
// This is what Spotify's single-stream player can never do: real crossfades,
// gapless-feeling loops, sample-accurate cue starts — and now on-beat cuts:
// a transition waits (≤ one beat) for the OUTGOING track's next beat
// boundary, and the incoming entry is advanced by the same wait so its
// musical timeline (and any drop landing) is preserved. Both edges of the
// cut sit on the grid — it reads as mixed, not triggered.
import { blendPlan, nextGridDelayMs, tempoLockRate } from '../conductor/beat'

/** Bass shelf below this frequency is what gets swapped between decks. */
const BASS_HZ = 180
const BASS_CUT_DB = -15

/** How each cue intent cuts. Song chains (groove fills) use a RADIO handoff:
 *  the outgoing song fades out long enough to sound like it's ending, then
 *  the next one enters — no blend, no bass swap, no tempo lock. ("The
 *  transitions are not good enough yet for DJ-like transitions" — Ethan,
 *  2026-08-16; the blend machinery stays for when the craft earns it back.)
 *  Buildups cut on the beat (timing-critical); drops fire exact-time. */
export function deckOptsFor(reason: string): { onBeat?: boolean; grid?: 'beat' | 'bar'; tempoLock?: boolean; radio?: boolean } {
  if (reason.startsWith('drop lands')) return { onBeat: false }
  if (reason.startsWith('loop back')) return { onBeat: true, grid: 'beat' }
  if (reason.startsWith('buildup')) return { onBeat: true, grid: 'beat' }
  return { radio: true } // groove fills & chains
}

/** Radio handoff shape: outgoing fades over OUT_S (long enough to read as
 *  "the song is ending"), incoming enters for the last OVERLAP_S of it. */
const RADIO_OUT_S = 6
const RADIO_OVERLAP_S = 1.5
const RADIO_IN_S = 2

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
    bass: BiquadFilterNode
    trackId: string
    positionAtMs: number
    startedAtCtx: number
    rate: number
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
    return this.current.positionAtMs + (this.ctx.currentTime - this.current.startedAtCtx) * 1000 * this.current.rate
  }

  /**
   * Start trackId at positionMs, crossfading out whatever is playing.
   * fadeSec ~0.8 feels like a radio DJ; loop-backs use a shorter fade so the
   * groove re-entry reads as a cut, not a wash. With onBeat, the cut is
   * deferred to the outgoing track's next beat boundary (needs its meta).
   */
  play(
    trackId: string,
    positionMs: number,
    fadeSec = 0.8,
    opts: { onBeat?: boolean; grid?: 'beat' | 'bar'; tempoLock?: boolean; radio?: boolean } = {},
  ): void {
    const ctx = this.ensureCtx()
    void ctx.resume()
    const buf = this.buffers.get(trackId)
    if (!buf) throw new Error(`no local audio for ${trackId}`)

    // Radio handoff (song chains): the outgoing song ENDS — a long fade to
    // silence — and the incoming one starts as its tail disappears. The
    // incoming position is advanced by the wait so the engine's model of
    // "what's playing where" stays true at the moment you actually hear it.
    if (opts.radio && this.current) {
      const now = ctx.currentTime
      const old = this.current
      const held = Math.max(old.gain.gain.value, 0.0001)
      old.gain.gain.cancelScheduledValues(now)
      old.gain.gain.setValueAtTime(held, now)
      old.gain.gain.exponentialRampToValueAtTime(0.0001, now + RADIO_OUT_S)
      old.src.stop(now + RADIO_OUT_S + 0.1)

      const tIn = now + RADIO_OUT_S - RADIO_OVERLAP_S
      const startPosMs = Math.max(0, positionMs + (RADIO_OUT_S - RADIO_OVERLAP_S) * 1000)
      const src = ctx.createBufferSource()
      src.buffer = buf
      const bass = ctx.createBiquadFilter()
      bass.type = 'lowshelf'
      bass.frequency.value = BASS_HZ
      bass.gain.value = 0
      const gain = ctx.createGain()
      src.connect(bass)
      bass.connect(gain)
      gain.connect(ctx.destination)
      gain.gain.setValueAtTime(0.0001, tIn)
      gain.gain.exponentialRampToValueAtTime(1, tIn + RADIO_IN_S)
      src.start(tIn, startPosMs / 1000)
      this.current = { src, gain, bass, trackId, positionAtMs: startPosMs, startedAtCtx: tIn, rate: 1 }
      return
    }

    const outMeta = this.current ? this.meta.get(this.current.trackId) : undefined
    const inMeta = this.meta.get(trackId)

    let delayMs = 0
    if (opts.onBeat && this.current) {
      const pos = this.playheadMs()
      // Fills cut on BARS like a real DJ; timing-sensitive cuts use beats.
      const beats = opts.grid === 'bar' ? 4 : 1
      if (outMeta?.bpm && pos != null) delayMs = nextGridDelayMs(pos, outMeta.bpm, outMeta.anchorMs, beats)
    }
    // Compatible tempos earn the DJ treatment: longer blend + bass swap,
    // and (for non-timing-critical cuts) the incoming track tempo-locks to
    // the outgoing one so the overlap phase-locks instead of drifting.
    const plan = blendPlan(fadeSec, outMeta?.bpm, inMeta?.bpm, { isDrop: !opts.onBeat })
    const blendSec = this.current ? plan.fadeSec : fadeSec
    const rate = opts.tempoLock && plan.bassSwap ? tempoLockRate(outMeta?.bpm, inMeta?.bpm) : 1

    const now = ctx.currentTime
    const t = now + delayMs / 1000
    // The incoming track enters later by the same wait — its timeline holds.
    const startPosMs = Math.max(0, positionMs + delayMs)

    const src = ctx.createBufferSource()
    src.buffer = buf
    src.playbackRate.value = rate
    const bass = ctx.createBiquadFilter()
    bass.type = 'lowshelf'
    bass.frequency.value = BASS_HZ
    const gain = ctx.createGain()
    src.connect(bass)
    bass.connect(gain)
    gain.connect(ctx.destination)
    gain.gain.setValueAtTime(0.0001, t)
    gain.gain.exponentialRampToValueAtTime(1, t + blendSec)
    src.start(t, startPosMs / 1000)

    const swapAt = t + blendSec * 0.5 // basses trade hands mid-blend
    if (plan.bassSwap && this.current) {
      // Incoming enters bass-cut, takes the low end at the swap.
      bass.gain.setValueAtTime(BASS_CUT_DB, t)
      bass.gain.setValueAtTime(BASS_CUT_DB, swapAt)
      bass.gain.linearRampToValueAtTime(0, swapAt + 0.35)
    } else {
      bass.gain.setValueAtTime(0, t)
    }

    if (this.current) {
      const old = this.current
      const held = Math.max(old.gain.gain.value, 0.0001)
      old.gain.gain.cancelScheduledValues(now)
      old.gain.gain.setValueAtTime(held, now)
      old.gain.gain.setValueAtTime(held, t) // stay full until the cut moment
      old.gain.gain.exponentialRampToValueAtTime(0.0001, t + blendSec)
      if (plan.bassSwap) {
        // Outgoing surrenders the low end as the incoming takes it.
        old.bass.gain.setValueAtTime(0, t)
        old.bass.gain.setValueAtTime(0, swapAt)
        old.bass.gain.linearRampToValueAtTime(BASS_CUT_DB, swapAt + 0.35)
      }
      old.src.stop(t + blendSec + 0.1)
    }
    this.current = { src, gain, bass, trackId, positionAtMs: startPosMs, startedAtCtx: t, rate }
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
