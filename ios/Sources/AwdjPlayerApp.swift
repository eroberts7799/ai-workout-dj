import SwiftUI

@main
struct AwdjPlayerApp: App {
  var body: some Scene {
    WindowGroup {
      TabView {
        SessionView().tabItem { Label("Session", systemImage: "figure.run") }
        SpikeView().tabItem { Label("Spike", systemImage: "waveform" ) }
      }
      .preferredColorScheme(.dark)
      .tint(Theme.pulseSolid)
    }
  }
}
