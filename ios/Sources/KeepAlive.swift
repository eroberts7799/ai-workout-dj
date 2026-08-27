// KeepAlive — background survival for the Spotify tier.
//
// The owned-files tier plays through DualDeck, which holds an active audio
// session, so iOS keeps the app alive in the pocket. The SPOTIFY tier plays
// nothing itself (audio comes from Spotify's own process) — so AWDJ has no
// audio session, and iOS suspends it the moment the screen locks. That
// killed the 8/27 run: the relay poll and all conducting stopped 2 minutes
// in (samples clustered at start + end, a 22-minute dead gap between).
//
// The fix is the well-worn one: emit inaudible silence through our own
// engine with `.mixWithOthers` (so Spotify keeps playing over it). The
// silence keeps the audio session — and thus background execution — alive,
// so RelayPoller keeps polling and the conductor keeps sending cuts.

import AVFoundation

final class KeepAlive {
  static let shared = KeepAlive()
  private let engine = AVAudioEngine()
  private var running = false

  func start() {
    guard !running else { return }
    let session = AVAudioSession.sharedInstance()
    // mixWithOthers is essential: without it our session would interrupt
    // Spotify. We are a silent passenger, not the driver.
    try? session.setCategory(.playback, mode: .default, options: [.mixWithOthers])
    try? session.setActive(true)

    let fmt = engine.outputNode.inputFormat(forBus: 0)
    let source = AVAudioSourceNode { _, _, frameCount, audioBufferList -> OSStatus in
      let abl = UnsafeMutableAudioBufferListPointer(audioBufferList)
      for buffer in abl {
        memset(buffer.mData, 0, Int(buffer.mDataByteSize)) // pure silence
      }
      return noErr
    }
    engine.attach(source)
    engine.connect(source, to: engine.mainMixerNode, format: fmt)
    engine.mainMixerNode.outputVolume = 0
    do {
      try engine.start()
      running = true
    } catch {
      // If the engine won't start we simply don't have background keep-alive;
      // the run still works while the screen is on.
    }
  }

  func stop() {
    guard running else { return }
    engine.stop()
    engine.reset()
    running = false
    // Hand the session back so the owned-files deck can reclaim it cleanly.
    try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
  }
}
