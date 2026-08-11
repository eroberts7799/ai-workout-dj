// The pocket conductor's session screen: import bundle + audio once,
// arm, press start on the watch, run.
import SwiftUI
import UniformTypeIdentifiers

struct SessionView: View {
  @StateObject private var engine = SessionEngine()
  @StateObject private var relay = RelayPoller()
  @State private var armed = true
  @State private var showBundlePicker = false
  @State private var showAudioPicker = false

  var body: some View {
    VStack(spacing: 20) {
      Text("AI Workout DJ").font(.title2).bold()

      Text(relay.line)
        .font(.system(.body, design: .monospaced))
        .foregroundColor(relay.fresh ? .green : .secondary)

      if let b = engine.bundle {
        VStack(alignment: .leading, spacing: 6) {
          Text("\(b.name) · \(Int(b.planEndMs / 60000))min · \(b.cues.count) cues").bold()
          ForEach(b.songs) { s in
            HStack {
              Text(engine.audioReady[s.trackId] == true ? "🎧" : "⚠️")
              Text(s.name).font(.footnote)
            }
          }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding()
        .background(Color.gray.opacity(0.12))
        .cornerRadius(10)
      }

      switch engine.phase {
      case .idle:
        Toggle("Arm Garmin auto-start", isOn: $armed).frame(maxWidth: 280)
        if engine.supportsLive {
          Toggle("🛰 LIVE mode (body-driven)", isOn: $engine.liveMode).frame(maxWidth: 280)
        }
        Button("Start now (3s)") {
          DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
            if engine.phase == .idle { engine.start(atOffsetMs: 0) }
          }
        }
        .disabled(!engine.allAudioReady)
        if engine.supportsLive {
          Button("🧪 Simulate run ×8 (no watch)") { engine.startSimulatedRun() }
            .font(.footnote)
        }
      case .running, .paused:
        Text(RelayPoller.clock(engine.clockMs)).font(.system(size: 48, design: .monospaced))
        if engine.liveMode || !engine.lastCommand.isEmpty {
          Text("\(engine.landingCount) landings · \(engine.lastCommand)")
            .font(.footnote)
            .foregroundColor(.secondary)
            .lineLimit(2)
        }
        HStack(spacing: 16) {
          Button(engine.phase == .paused ? "Resume" : "Pause") {
            engine.phase == .paused ? engine.resumeSession() : engine.pauseSession()
          }
          Button("Stop") { engine.stopSession() }
        }
      case .done:
        Text("Done — \(engine.firedCount) cues fired").foregroundColor(.green)
        Button("Reset") { engine.reset() }
      }

      Text(engine.status).font(.footnote).foregroundColor(.secondary)

      HStack(spacing: 16) {
        Button("Import bundle") { showBundlePicker = true }
          .fileImporter(isPresented: $showBundlePicker, allowedContentTypes: [.json]) { result in
            if case .success(let url) = result { engine.importBundle(from: url) }
          }
        Button("Import audio files") { showAudioPicker = true }
          .fileImporter(isPresented: $showAudioPicker, allowedContentTypes: [.audio], allowsMultipleSelection: true) { result in
            if case .success(let urls) = result { engine.importAudio(from: urls) }
          }
      }
      .font(.footnote)
    }
    .padding()
    .onAppear {
      engine.restore()
      relay.onSample = { [weak engine] s in
        guard let engine else { return }
        engine.handleGarmin(event: s.event, timerMs: s.timerMs, receivedAt: s.receivedAt, armed: armed)
        // LIVE mode: every fresh watch sample advances the conductor
        // (unless a simulated runner is already driving it).
        if engine.liveMode, !engine.simulating, let t = s.timerMs {
          engine.advanceLive(timerMs: t, distanceM: s.distanceM)
        }
      }
    }
  }
}
