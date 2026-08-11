// DualDeck — the iPhone incarnation of the crossfade engine.
// Two AVAudioPlayerNodes on one engine; cuts are sample-accurate scheduled
// segments, transitions are gain-ramped crossfades. This is the spike that
// proves the phone can do what the browser LocalDeck does — in the pocket,
// in the background, mid-run.
import AVFoundation

final class DualDeck {
  private let engine = AVAudioEngine()
  private let players = [AVAudioPlayerNode(), AVAudioPlayerNode()]
  private var active = 0
  private var files: [String: AVAudioFile] = [:]
  private var fadeTimer: Timer?

  init() {
    for p in players {
      engine.attach(p)
      engine.connect(p, to: engine.mainMixerNode, format: nil)
      p.volume = 0
    }
    try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .default)
    try? AVAudioSession.sharedInstance().setActive(true)
    try? engine.start()
  }

  func load(id: String, url: URL) throws {
    files[id] = try AVAudioFile(forReading: url)
  }

  func has(id: String) -> Bool { files[id] != nil }

  /// Start `id` at positionMs, crossfading from whatever plays now.
  func play(id: String, positionMs: Double, fadeSec: Double = 0.8) {
    guard let file = files[id] else { return }
    let incoming = players[1 - active]
    let outgoing = players[active]
    active = 1 - active

    incoming.stop()
    let sampleRate = file.processingFormat.sampleRate
    let startFrame = AVAudioFramePosition(positionMs / 1000.0 * sampleRate)
    let frames = AVAudioFrameCount(max(0, file.length - startFrame))
    guard frames > 0 else { return }
    incoming.scheduleSegment(file, startingFrame: startFrame, frameCount: frames, at: nil)
    incoming.volume = 0
    incoming.play()

    crossfade(from: outgoing, to: incoming, seconds: fadeSec)
  }

  private func crossfade(from: AVAudioPlayerNode, to: AVAudioPlayerNode, seconds: Double) {
    fadeTimer?.invalidate()
    let steps = max(1, Int(seconds * 60))
    var step = 0
    let fromStart = from.volume
    fadeTimer = Timer.scheduledTimer(withTimeInterval: seconds / Double(steps), repeats: true) { t in
      step += 1
      let x = Float(step) / Float(steps)
      to.volume = x
      from.volume = fromStart * (1 - x)
      if step >= steps {
        t.invalidate()
        from.stop()
        from.volume = 0
      }
    }
  }

  func pause() { players.forEach { $0.pause() } }
  func resume() { players[active].play() }
}
