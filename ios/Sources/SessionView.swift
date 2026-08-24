// The pocket conductor's session screen: import bundle + audio once,
// arm, press start on the watch, run.
import SwiftUI
import UniformTypeIdentifiers

struct SessionView: View {
  @StateObject private var engine = SessionEngine()
  @StateObject private var relay = RelayPoller()
  @State private var armed = true
  @State private var simSpeed = 8.0
  @State private var showBundlePicker = false
  @State private var showAudioPicker = false
  @AppStorage("awdj.profileName") private var profileName = ""
  @AppStorage("awdj.profilePhone") private var profilePhone = ""
  @State private var showProfile = false
  @ObservedObject private var spotify = SpotifyAuth.shared
  @ObservedObject private var bleHr = BleHeartRate.shared
  @State private var showClientIdPrompt = false
  @State private var clientIdText = ""

  var body: some View {
    // ScrollView, not bare VStack: a 44-track crate's readiness list overflows
    // any screen — without scrolling, the import buttons become unreachable
    // (build 7 froze exactly this way the first time a real bundle landed).
    ScrollView {
    VStack(spacing: 20) {
      VStack(spacing: 4) {
        Text(profileName.isEmpty ? "AWDJ · FIELD UNIT" : "AWDJ · FIELD UNIT · \(profileName.uppercased())")
          .fieldLabel()
          .foregroundColor(Theme.faded)
        Text("The music moves first.")
          .fieldDisplay(30)
          .textCase(.uppercase)
      }
      .onTapGesture { showProfile = true }

      Text(relay.line)
        .fieldMono(12)
        .foregroundColor(relay.fresh ? Theme.olive : Theme.faded)

      if let b = engine.bundle {
        VStack(alignment: .leading, spacing: 8) {
          SectionBar()
          Text("\(b.name) · \(Int(b.planEndMs / 60000))min · \(b.cues.count) cues")
            .fieldSubhead()
            .textCase(.uppercase)
          // Compact readiness: problems get named, the healthy majority is a
          // count — 44 tracks must never bury the controls again.
          let missing = b.songs.filter { engine.audioReady[$0.trackId] != true }
          if missing.isEmpty {
            Text("✓ all \(b.songs.count) songs ready")
              .fieldMono(12, weight: .bold)
              .foregroundColor(Theme.olive)
          } else {
            Text("✓ \(b.songs.count - missing.count) ready · \(missing.count) missing audio:")
              .fieldMono(12, weight: .bold)
              .foregroundColor(Theme.fail)
            ForEach(missing) { s in
              HStack(spacing: 8) {
                Text("!").fieldMono(12, weight: .bold).foregroundColor(Theme.fail)
                Text(s.name).fieldMono(12)
              }
            }
          }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
      }

      switch engine.phase {
      case .idle:
        Menu("Program ▾") {
          ForEach(SessionEngine.builtinPrograms, id: \.resource) { p in
            Button(p.title) { engine.loadBuiltin(p.resource) }
          }
        }
        Toggle("Arm Garmin auto-start", isOn: $armed).frame(maxWidth: 280)
        if engine.supportsLive {
          Toggle("LIVE mode (body-driven)", isOn: $engine.liveMode).frame(maxWidth: 280)
        }
        Button("Start now (3s)") {
          DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
            if engine.phase == .idle { engine.start(atOffsetMs: 0) }
          }
        }
        .buttonStyle(ArmButtonStyle())
        .disabled(!engine.allAudioReady)
        if engine.supportsLive {
          Picker("music", selection: $engine.musicSource) {
            Text("Owned files").tag(SessionEngine.MusicSource.ownedFiles)
            Text("Spotify").tag(SessionEngine.MusicSource.spotify)
          }
          .pickerStyle(.segmented)
          .frame(maxWidth: 300)
          if engine.musicSource == .spotify && !spotify.connected {
            Button("Connect Spotify") {
              if (spotify.clientId ?? "").isEmpty {
                showClientIdPrompt = true
              } else {
                spotify.login { err in if let err { engine.status = err } }
              }
            }
            .buttonStyle(FieldButtonStyle())
          }
          Button(engine.musicSource == .spotify
                 ? "Trail run — Spotify (downloaded playlist)"
                 : "Trail run — phone sensors, no signal needed") { engine.startTrailRun() }
            .buttonStyle(FieldButtonStyle())
            .disabled(engine.musicSource == .ownedFiles ? !engine.allAudioReady : !spotify.connected)
          HStack(spacing: 8) {
            Button("Simulate run (no watch)") { engine.startSimulatedRun(speed: simSpeed) }
              .buttonStyle(FieldButtonStyle())
            Picker("speed", selection: $simSpeed) {
              ForEach([1.0, 2.0, 4.0, 8.0], id: \.self) { Text("×\(Int($0))").tag($0) }
            }
            .pickerStyle(.segmented)
            .frame(maxWidth: 160)
          }
          .font(.footnote)
          Text(simSpeed == 1 ? "×1 = full dress rehearsal, real loop lengths" : "accelerated: loop-backs muted (time compression artifact)")
            .font(.caption2)
            .foregroundColor(.secondary)
        }
      case .running, .paused:
        Text(RelayPoller.clock(engine.clockMs)).fieldMono(48, weight: .heavy)
        if engine.trailMode {
          let hr = bleHr.bpm != nil ? String(format: "%.0f bpm", bleHr.bpm!) : bleHr.state
          Text(String(format: "%.2f km · phone sensors · ", engine.phoneSensors.distanceM / 1000) + hr)
            .fieldMono(12)
            .foregroundColor(Theme.olive)
        }
        if engine.liveMode || !engine.lastCommand.isEmpty {
          Text("\(engine.landingCount) landings · \(engine.lastCommand)")
            .fieldMono(12)
            .foregroundColor(Theme.faded)
            .lineLimit(2)
        }
        HStack(spacing: 24) {
          Button(engine.phase == .paused ? "Resume" : "Pause") {
            engine.phase == .paused ? engine.resumeSession() : engine.pauseSession()
          }
          .buttonStyle(FieldButtonStyle())
          Button("Stop") { engine.stopSession() }
            .buttonStyle(FieldButtonStyle(color: Theme.fail))
        }
      case .done:
        Text("Done — \(engine.firedCount) cues fired")
          .fieldDisplay(24)
          .textCase(.uppercase)
          .foregroundColor(Theme.olive)
        Button("Reset") { engine.reset() }
          .buttonStyle(FieldButtonStyle())
      }

      Text(engine.status).fieldMono(11).foregroundColor(Theme.faded)

      HStack(spacing: 24) {
        Button("Import bundle") { showBundlePicker = true }
          .buttonStyle(FieldButtonStyle(color: Theme.faded))
          .fileImporter(isPresented: $showBundlePicker, allowedContentTypes: [.json]) { result in
            if case .success(let url) = result { engine.importBundle(from: url) }
          }
        Button("Import audio files") { showAudioPicker = true }
          .buttonStyle(FieldButtonStyle(color: Theme.faded))
          .fileImporter(isPresented: $showAudioPicker, allowedContentTypes: [.audio], allowsMultipleSelection: true) { result in
            if case .success(let urls) = result { engine.importAudio(from: urls) }
          }
      }
    }
    .padding()
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(Theme.paper.ignoresSafeArea())
    .foregroundColor(Theme.ink)
    .tint(Theme.olive)
    .alert("Spotify Client ID", isPresented: $showClientIdPrompt) {
      TextField("Client ID (from developer dashboard)", text: $clientIdText)
      Button("Save & Connect") {
        spotify.clientId = clientIdText.trimmingCharacters(in: .whitespaces)
        spotify.login { err in if let err { engine.status = err } }
      }
      Button("Cancel", role: .cancel) {}
    } message: {
      Text("Same Client ID you use in the web app — one-time setup.")
    }
    .sheet(isPresented: $showProfile) {
      VStack(spacing: 16) {
        Text("Who's working out?").fieldDisplay(24).textCase(.uppercase)
        Text("Your name labels your sessions so the DJ can learn YOUR body. Phone is optional — only used so Ethan can follow up on your feedback.")
          .font(.footnote).foregroundColor(Theme.faded).multilineTextAlignment(.center)
        TextField("Name", text: $profileName)
          .textFieldStyle(.plain)
          .font(.system(size: 15, design: .monospaced))
          .padding(.vertical, 6)
          .overlay(alignment: .bottom) { Rectangle().fill(Theme.seam).frame(height: 2) }
        TextField("Phone (optional)", text: $profilePhone)
          .textFieldStyle(.plain)
          .font(.system(size: 15, design: .monospaced))
          .padding(.vertical, 6)
          .overlay(alignment: .bottom) { Rectangle().fill(Theme.seam).frame(height: 2) }
          .keyboardType(.phonePad)
        Button(profileName.isEmpty ? "Skip for now" : "Let's go") { showProfile = false }
          .buttonStyle(ArmButtonStyle())
      }
      .padding(24)
      .background(Theme.paper)
      .foregroundColor(Theme.ink)
      .presentationDetents([.medium])
    }
    .onAppear {
      if profileName.isEmpty { showProfile = true }
      engine.restore()
      relay.onSample = { [weak engine] s in
        guard let engine else { return }
        engine.handleGarmin(event: s.event, timerMs: s.timerMs, receivedAt: s.receivedAt, armed: armed)
        // LIVE mode: every fresh watch sample advances the conductor
        // (unless a simulated runner is already driving it).
        if let t = s.timerMs, !engine.simulating {
          if engine.liveMode {
            engine.advanceLive(
              timerMs: t, distanceM: s.distanceM, hr: s.hr, altitudeM: s.altitude,
              wkStepSeq: s.wkStepSeq,
              wkKind: s.wkStep?.kind, wkDurationType: s.wkStep?.durationType,
              wkDurationValue: s.wkStep?.durationValue, wkNextKind: s.wkNext?.kind
            )
          }
          // Full-fidelity capture in every mode (workout steps, altitude —
          // the flywheel and the follow-mode brain learn from these).
          engine.recordSample(s)
        }
      }
    }
  }
}
