import SwiftUI

@main
struct AwdjPlayerApp: App {
  var body: some Scene {
    WindowGroup {
      TabView {
        SessionView().tabItem { Label("Session", systemImage: "figure.run") }
        // Dev bench only — latency/crossfade proofs. Never ships to testers.
        #if DEBUG
          SpikeView().tabItem { Label("Spike", systemImage: "waveform") }
        #endif
      }
    }
  }
}
