// LocalDeck — a Web Audio dual-deck engine for owned audio files.
// This is what Spotify's single-stream player can never do: real crossfades,
// gapless-feeling loops, sample-accurate cue starts.

export class LocalDeck {
  private ctx: AudioContext | null = null
  private buffers = new Map<string, AudioBuffer>()
  private current: { src: AudioBufferSourceNode; gain: GainNode } | null = null

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

  /**
   * Start trackId at positionMs, crossfading out whatever is playing.
   * fadeSec ~0.8 feels like a radio DJ; loop-backs use a shorter fade so the
   * groove re-entry reads as a cut, not a wash.
   */
  play(trackId: string, positionMs: number, fadeSec = 0.8): void {
    const ctx = this.ensureCtx()
    void ctx.resume()
    const buf = this.buffers.get(trackId)
    if (!buf) throw new Error(`no local audio for ${trackId}`)
    const t = ctx.currentTime
    const src = ctx.createBufferSource()
    src.buffer = buf
    const gain = ctx.createGain()
    src.connect(gain)
    gain.connect(ctx.destination)
    gain.gain.setValueAtTime(0.0001, t)
    gain.gain.exponentialRampToValueAtTime(1, t + fadeSec)
    src.start(t, Math.max(0, positionMs) / 1000)

    if (this.current) {
      const old = this.current
      old.gain.gain.cancelScheduledValues(t)
      old.gain.gain.setValueAtTime(Math.max(old.gain.gain.value, 0.0001), t)
      old.gain.gain.exponentialRampToValueAtTime(0.0001, t + fadeSec)
      old.src.stop(t + fadeSec + 0.1)
    }
    this.current = { src, gain }
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
