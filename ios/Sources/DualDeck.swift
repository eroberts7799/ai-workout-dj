// DualDeck — the iPhone incarnation of the crossfade engine, now with the
// full DJ treatment ported from the web deck: on-beat/bar-aligned cuts,
// tempo-locked blends (AVAudioUnitTimePitch rate — no chipmunk), and the
// bass swap (per-deck low-shelf EQ trades the low end mid-blend).
import AVFoundation

struct DeckTrackMeta {
  let bpm: Double?
  let anchorMs: Double
}

final class DualDeck {
  private struct Side {
    let player = AVAudioPlayerNode()
    let timePitch = AVAudioUnitTimePitch()
    let eq = AVAudioUnitEQ(numberOfBands: 1)
  }

  private static let bassHz: Float = 180
  private static let bassCutDb: Float = -15
  /// Song-change crossfade — mirrors local-deck.ts: Spotify's shape, both
  /// sides ramping over the same 5s window.
  private static let xfadeS = 5.0

  private let engine = AVAudioEngine()
  private let sides = [Side(), Side()]
  private var active = 0
  private var files: [String: AVAudioFile] = [:]
  private var meta: [String: DeckTrackMeta] = [:]
  private var fadeTimer: Timer?
  private var current: (trackId: String, positionAtMs: Double, startedAtHost: Double, rate: Double)?

  init() {
    for s in sides {
      engine.attach(s.player)
      engine.attach(s.timePitch)
      engine.attach(s.eq)
      let band = s.eq.bands[0]
      band.filterType = .lowShelf
      band.frequency = Self.bassHz
      band.gain = 0
      band.bypass = false
      engine.connect(s.player, to: s.timePitch, format: nil)
      engine.connect(s.timePitch, to: s.eq, format: nil)
      engine.connect(s.eq, to: engine.mainMixerNode, format: nil)
      s.player.volume = 0
    }
    // Session + engine start DEFERRED to play(): the deck's category is
    // non-mixing .playback by design (owned tier owns the audio), but
    // grabbing it at construction meant every app launch armed a session
    // that pauses Spotify the moment it activates (9/2 shakeout: a
    // Spotify session with the deck idle still killed the music).
  }

  func load(id: String, url: URL) throws {
    files[id] = try AVAudioFile(forReading: url)
  }

  func has(id: String) -> Bool { files[id] != nil }

  func setMeta(id: String, bpm: Double?, anchorMs: Double) {
    meta[id] = DeckTrackMeta(bpm: bpm, anchorMs: anchorMs)
  }

  /// Human-readable engine state for the spike UI.
  func debugState() -> String {
    "engine=\(engine.isRunning ? "running" : "STOPPED") files=\(files.count) activeVol=\(sides[active].player.volume)"
  }

  /// Playhead of the active track right now, ms (nil when nothing plays).
  private func playheadMs() -> Double? {
    guard let c = current else { return nil }
    let elapsed = (hostSeconds() - c.startedAtHost) * 1000
    return c.positionAtMs + max(0, elapsed) * c.rate
  }

  private func hostSeconds() -> Double {
    AVAudioTime.seconds(forHostTime: mach_absolute_time())
  }

  /// Start `id` at positionMs, crossfading from whatever plays now.
  /// The DJ treatment mirrors the web deck: opts decide beat/bar alignment
  /// and tempo-locking; blendPlan decides overlap length + bass swap.
  func play(id: String, positionMs: Double, fadeSec: Double = 0.8, opts: BeatMath.DeckOpts? = nil) throws {
    if !engine.isRunning {
      try AVAudioSession.sharedInstance().setCategory(.playback, mode: .default)
      try AVAudioSession.sharedInstance().setActive(true)
      try engine.start()
    }
    guard let file = files[id] else { throw NSError(domain: "awdj", code: 1, userInfo: [NSLocalizedDescriptionKey: "no file \(id)"]) }
    let o = opts ?? BeatMath.DeckOpts(onBeat: false, barGrid: false, tempoLock: false)

    // Radio handoff (song chains): outgoing ENDS with a long fade; incoming
    // starts on its tail, position advanced by the wait so the engine's
    // model matches what's audible. No blend, no bass swap, no tempo lock.
    if o.radio, current != nil {
      let incoming = sides[1 - active]
      let outgoing = sides[active]
      active = 1 - active
      incoming.player.stop()
      incoming.timePitch.rate = 1
      incoming.eq.bands[0].gain = 0
      // Spotify-style crossfade: both sides ramp over the same window,
      // incoming from wherever the engine asked (usually 0:00).
      let startPosMs = max(0, positionMs)
      let sampleRate = file.processingFormat.sampleRate
      let startFrame = AVAudioFramePosition(startPosMs / 1000.0 * sampleRate)
      let frames = AVAudioFrameCount(max(0, file.length - startFrame))
      guard frames > 0 else { return }
      incoming.player.scheduleSegment(file, startingFrame: startFrame, frameCount: frames, at: nil)
      incoming.player.volume = 0
      incoming.player.play()
      crossfade(from: outgoing, to: incoming, seconds: Self.xfadeS, afterDelay: 0, bassSwap: false)
      current = (trackId: id, positionAtMs: startPosMs, startedAtHost: hostSeconds(), rate: 1)
      return
    }

    let outMeta = current.flatMap { meta[$0.trackId] }
    let inMeta = meta[id]

    var delayMs: Double = 0
    if o.onBeat, let pos = playheadMs(), let outBpm = outMeta?.bpm {
      delayMs = BeatMath.nextGridDelayMs(posMs: pos, bpm: outBpm, anchorMs: outMeta?.anchorMs ?? 0, beatsPerUnit: o.barGrid ? 4 : 1)
    }
    let plan = BeatMath.blendPlan(requestedFadeSec: fadeSec, outgoingBpm: outMeta?.bpm, incomingBpm: inMeta?.bpm, isDrop: !o.onBeat)
    let blendSec = current != nil ? plan.fadeSec : fadeSec
    let rate = o.tempoLock && plan.bassSwap ? BeatMath.tempoLockRate(outgoingBpm: outMeta?.bpm, incomingBpm: inMeta?.bpm) : 1

    let incoming = sides[1 - active]
    let outgoing = sides[active]
    active = 1 - active

    incoming.player.stop()
    incoming.timePitch.rate = Float(rate)
    // The incoming track enters later by the beat-wait — its timeline holds.
    let startPosMs = max(0, positionMs + delayMs)
    let sampleRate = file.processingFormat.sampleRate
    let startFrame = AVAudioFramePosition(startPosMs / 1000.0 * sampleRate)
    let frames = AVAudioFrameCount(max(0, file.length - startFrame))
    guard frames > 0 else { return }
    incoming.player.scheduleSegment(file, startingFrame: startFrame, frameCount: frames, at: nil)
    incoming.player.volume = 0
    incoming.eq.bands[0].gain = plan.bassSwap && current != nil ? Self.bassCutDb : 0

    // Sample-accurate delayed start at the beat/bar boundary.
    let startHost = hostSeconds() + delayMs / 1000
    if delayMs > 5 {
      incoming.player.play(at: AVAudioTime(hostTime: AVAudioTime.hostTime(forSeconds: startHost)))
    } else {
      incoming.player.play()
    }

    crossfade(from: outgoing, to: incoming, seconds: blendSec, afterDelay: delayMs / 1000, bassSwap: plan.bassSwap && current != nil)
    current = (trackId: id, positionAtMs: startPosMs, startedAtHost: startHost, rate: rate)
  }

  private func crossfade(from: Side, to: Side, seconds: Double, afterDelay: Double, bassSwap: Bool) {
    fadeTimer?.invalidate()
    let steps = max(1, Int(seconds * 60))
    var step = 0
    let fromStart = from.player.volume
    let interval = seconds / Double(steps)
    let timer = Timer(timeInterval: interval, repeats: true) { t in
      step += 1
      let x = Float(step) / Float(steps)
      to.player.volume = x
      from.player.volume = fromStart * (1 - x)
      if bassSwap {
        // Basses trade hands mid-blend: incoming rises from the cut floor,
        // outgoing surrenders the low end past the midpoint.
        if x >= 0.5 {
          let y = (x - 0.5) * 2
          to.eq.bands[0].gain = Self.bassCutDb * (1 - y)
          from.eq.bands[0].gain = Self.bassCutDb * y
        }
      }
      if step >= steps {
        t.invalidate()
        from.player.stop()
        from.player.volume = 0
        from.eq.bands[0].gain = 0
        to.eq.bands[0].gain = 0
        // to.timePitch.rate HOLDS — snapping back to 1 mid-track would be
        // audible; each side resets its rate when it next takes a cut.
      }
    }
    if afterDelay > 0.005 {
      DispatchQueue.main.asyncAfter(deadline: .now() + afterDelay) {
        RunLoop.main.add(timer, forMode: .common)
        self.fadeTimer = timer
      }
    } else {
      RunLoop.main.add(timer, forMode: .common)
      fadeTimer = timer
    }
  }

  func pause() { sides.forEach { $0.player.pause() } }
  func resume() { sides[active].player.play() }

  func stop() {
    fadeTimer?.invalidate()
    sides.forEach {
      $0.player.stop()
      $0.player.volume = 0
      $0.eq.bands[0].gain = 0
    }
    current = nil
  }
}
