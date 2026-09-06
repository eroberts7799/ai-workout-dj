// CoachVoice — speaks the CoachEngine's cues over whatever is playing.
// Spotify tier: the synthesizer runs its OWN audio session
// (usesApplicationAudioSession = false), which ducks other apps' audio for
// the length of the utterance and restores it — the keep-alive session
// stays mixWithOthers so nothing else changes. Owned-files tier: the deck
// is our own audio, so we dip its gain ourselves around each line.
// Voice: the best installed en-US voice (premium > enhanced > default).
import AVFoundation
import Foundation

@MainActor
final class CoachVoice: NSObject, AVSpeechSynthesizerDelegate {
  static let shared = CoachVoice()
  private let synth = AVSpeechSynthesizer()
  private var voice: AVSpeechSynthesisVoice?
  /// Called around each utterance (owned tier dips the deck).
  var onSpeaking: ((Bool) -> Void)?
  var enabled: Bool {
    get { UserDefaults.standard.object(forKey: "awdj.coach") as? Bool ?? true }
    set { UserDefaults.standard.set(newValue, forKey: "awdj.coach") }
  }

  override init() {
    super.init()
    synth.delegate = self
    let candidates = AVSpeechSynthesisVoice.speechVoices().filter { $0.language.hasPrefix("en") }
    let rank: (AVSpeechSynthesisVoice) -> Int = { v in
      (v.quality == .premium ? 2 : v.quality == .enhanced ? 1 : 0) * 10 + (v.language == "en-US" ? 1 : 0)
    }
    voice = candidates.max(by: { rank($0) < rank($1) }) ?? AVSpeechSynthesisVoice(language: "en-US")
  }

  /// Speak one line now. A line arriving mid-utterance queues behind it —
  /// the engine's 8s gap makes that rare.
  func speak(_ text: String, ownsAudio: Bool) {
    guard enabled else { return }
    let u = AVSpeechUtterance(string: text)
    u.voice = voice
    u.rate = AVSpeechUtteranceDefaultSpeechRate * 0.98
    synth.usesApplicationAudioSession = ownsAudio
    synth.speak(u)
  }

  func stop() {
    synth.stopSpeaking(at: .immediate)
  }

  nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didStart utterance: AVSpeechUtterance) {
    Task { @MainActor in self.onSpeaking?(true) }
  }
  nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
    Task { @MainActor in self.onSpeaking?(false) }
  }
  nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
    Task { @MainActor in self.onSpeaking?(false) }
  }
}
