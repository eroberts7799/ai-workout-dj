// Hour-one spike screen: prove crossfades + relay polling on iOS.
// Success = tapping between decks blends smoothly, and the ⌚ line shows
// live data from the watch WITHOUT the Mac in the loop.
import SwiftUI

struct SpikeView: View {
  @StateObject private var relay = RelayPoller()
  @State private var deck = DualDeck()
  @State private var status = "load the test tracks to begin"
  @State private var loaded = false

  var body: some View {
    VStack(spacing: 24) {
      Text("AWDJ — iOS spike").font(.title2).bold()

      Text(relay.line)
        .font(.system(.body, design: .monospaced))
        .foregroundColor(relay.fresh ? .green : .secondary)

      if !loaded {
        Button("Load test tracks") {
          do {
            guard
              let a = Bundle.main.url(forResource: "tone-a", withExtension: "wav"),
              let b = Bundle.main.url(forResource: "tone-b", withExtension: "wav")
            else {
              status = "test tones missing from bundle"
              return
            }
            try deck.load(id: "a", url: a)
            try deck.load(id: "b", url: b)
            loaded = true
            status = "loaded — try the decks"
          } catch {
            status = "load failed: \(error.localizedDescription)"
          }
        }
      } else {
        HStack(spacing: 16) {
          Button("Deck A @ 5s") { deck.play(id: "a", positionMs: 5000); status = "A playing" }
          Button("Deck B @ 20s") { deck.play(id: "b", positionMs: 20000); status = "crossfaded to B" }
        }
        HStack(spacing: 16) {
          Button("Pause") { deck.pause() }
          Button("Resume") { deck.resume() }
        }
      }

      Text(status).font(.footnote).foregroundColor(.secondary)
    }
    .padding()
  }
}
