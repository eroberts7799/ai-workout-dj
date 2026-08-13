// The pocket conductor's session screen — members-club dark, one hot pulse.
// Import bundle + audio once, arm, press start on the watch, run.
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

  var body: some View {
    ZStack {
      Theme.bg.ignoresSafeArea()

      ScrollView(showsIndicators: false) {
        VStack(spacing: 22) {
          header
          watchLine
          if let b = engine.bundle { bundleCard(b) }
          phaseSection
          if !engine.status.isEmpty {
            Text(engine.status)
              .font(.footnote)
              .foregroundColor(Theme.inkFaint)
              .multilineTextAlignment(.center)
          }
          importRow
        }
        .padding(20)
        .padding(.top, 8)
      }
    }
    .preferredColorScheme(.light)
    .tint(Theme.pulseSolid)
    .sheet(isPresented: $showProfile) { profileSheet }
    .onAppear {
      if profileName.isEmpty { showProfile = true }
      engine.restore()
      relay.onSample = { [weak engine] s in
        guard let engine else { return }
        engine.handleGarmin(event: s.event, timerMs: s.timerMs, receivedAt: s.receivedAt, armed: armed)
        if let t = s.timerMs, !engine.simulating {
          if engine.liveMode {
            engine.advanceLive(timerMs: t, distanceM: s.distanceM, hr: s.hr)
          }
          engine.recordSample(s)
        }
      }
    }
  }

  // MARK: - Pieces

  private var header: some View {
    VStack(spacing: 4) {
      Text("AWDJ")
        .font(.system(size: 13, weight: .semibold))
        .tracking(6)
        .foregroundColor(Theme.inkFaint)
      Text(profileName.isEmpty ? "Your set awaits." : "Good to see you, \(profileName).")
        .displaySerif(30)
        .foregroundColor(Theme.ink)
        .multilineTextAlignment(.center)
        .onTapGesture { showProfile = true }
    }
    .padding(.top, 10)
  }

  private var watchLine: some View {
    HStack(spacing: 8) {
      Circle()
        .fill(relay.fresh ? Color.green : Theme.inkFaint)
        .frame(width: 7, height: 7)
      Text(relay.fresh ? relay.line.replacingOccurrences(of: "⌚ ", with: "") : "waiting for your watch…")
        .font(.system(size: 13, design: .monospaced))
        .foregroundColor(relay.fresh ? Theme.inkDim : Theme.inkFaint)
    }
  }

  private func bundleCard(_ b: SessionBundle) -> some View {
    VStack(alignment: .leading, spacing: 12) {
      Hairline()
      Text("TONIGHT'S PROGRAM")
        .font(.system(size: 11, weight: .semibold))
        .tracking(3)
        .foregroundColor(Theme.inkFaint)
      Text("\(b.name) — \(Int(b.planEndMs / 60000)) min · \(b.cues.count) cues")
        .displaySerif(19)
        .foregroundColor(Theme.ink)
      VStack(alignment: .leading, spacing: 7) {
        ForEach(b.songs) { s in
          HStack(spacing: 10) {
            Circle()
              .fill(engine.audioReady[s.trackId] == true ? AnyShapeStyle(Theme.pulse) : AnyShapeStyle(Theme.inkFaint))
              .frame(width: 5, height: 5)
            Text(s.name)
              .font(.system(size: 14))
              .foregroundColor(engine.audioReady[s.trackId] == true ? Theme.inkDim : Theme.inkFaint)
              .lineLimit(1)
          }
        }
      }
      Hairline()
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  @ViewBuilder private var phaseSection: some View {
    switch engine.phase {
    case .idle:
      VStack(spacing: 14) {
        toggleRow("Arm watch auto-start", isOn: $armed)
        if engine.supportsLive {
          toggleRow("Body-driven (LIVE)", isOn: $engine.liveMode)
        }
        Button("Start the set") {
          DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
            if engine.phase == .idle { engine.start(atOffsetMs: 0) }
          }
        }
        .buttonStyle(PulseButtonStyle())
        .disabled(!engine.allAudioReady)
        .opacity(engine.allAudioReady ? 1 : 0.4)

        if engine.supportsLive {
          VStack(spacing: 8) {
            Button("Rehearse without a watch") { engine.startSimulatedRun(speed: simSpeed) }
              .buttonStyle(QuietButtonStyle())
            Picker("speed", selection: $simSpeed) {
              ForEach([1.0, 2.0, 4.0, 8.0], id: \.self) { Text("×\(Int($0))").tag($0) }
            }
            .pickerStyle(.segmented)
            .frame(maxWidth: 200)
            Text(simSpeed == 1 ? "×1 — the real thing, full loop lengths" : "accelerated — transitions only, loops trimmed")
              .font(.caption2)
              .foregroundColor(Theme.inkFaint)
          }
        }
      }
      .frame(maxWidth: .infinity)

    case .running, .paused:
      VStack(spacing: 12) {
        Text(RelayPoller.clock(engine.clockMs))
          .font(.system(size: 64, weight: .light, design: .monospaced))
          .foregroundColor(Theme.ink)
        if engine.liveMode || !engine.lastCommand.isEmpty {
          Text(engine.lastCommand.isEmpty ? " " : engine.lastCommand)
            .font(.system(size: 13))
            .foregroundColor(Theme.inkDim)
            .lineLimit(2)
            .multilineTextAlignment(.center)
          if engine.landingCount > 0 {
            Text("\(engine.landingCount) drops landed")
              .font(.system(size: 12, weight: .semibold))
              .foregroundStyle(Theme.pulse)
          }
        }
        HStack(spacing: 12) {
          Button(engine.phase == .paused ? "Resume" : "Pause") {
            engine.phase == .paused ? engine.resumeSession() : engine.pauseSession()
          }
          .buttonStyle(QuietButtonStyle())
          Button("End set") { engine.stopSession() }
            .buttonStyle(QuietButtonStyle())
        }
      }
      .padding(.vertical, 10)

    case .done:
      VStack(spacing: 12) {
        Text("That's the set.")
          .displaySerif(26)
          .foregroundColor(Theme.ink)
        Text("\(engine.firedCount) cues · session saved to the flywheel")
          .font(.footnote)
          .foregroundColor(Theme.inkDim)
        Button("New session") { engine.reset() }
          .buttonStyle(QuietButtonStyle())
      }
      .padding(.vertical, 10)
    }
  }

  private func toggleRow(_ label: String, isOn: Binding<Bool>) -> some View {
    Toggle(label, isOn: isOn)
      .font(.system(size: 15))
      .foregroundColor(Theme.inkDim)
      .tint(Theme.pulseSolid)
      .padding(.horizontal, 18)
      .padding(.vertical, 4)
      .frame(maxWidth: 340)
  }

  private var importRow: some View {
    HStack(spacing: 12) {
      Button("Import program") { showBundlePicker = true }
        .buttonStyle(QuietButtonStyle())
        .fileImporter(isPresented: $showBundlePicker, allowedContentTypes: [.json]) { result in
          if case .success(let url) = result { engine.importBundle(from: url) }
        }
      Button("Import music") { showAudioPicker = true }
        .buttonStyle(QuietButtonStyle())
        .fileImporter(isPresented: $showAudioPicker, allowedContentTypes: [.audio], allowsMultipleSelection: true) { result in
          if case .success(let urls) = result { engine.importAudio(from: urls) }
        }
    }
    .padding(.top, 6)
  }

  private var profileSheet: some View {
    ZStack {
      Theme.bg.ignoresSafeArea()
      VStack(spacing: 18) {
        Text("AWDJ")
          .font(.system(size: 12, weight: .semibold))
          .tracking(6)
          .foregroundColor(Theme.inkFaint)
        Text("Who's working out?")
          .displaySerif(28)
          .foregroundColor(Theme.ink)
        Text("Your name labels your sessions so the DJ learns your body. Phone is optional — only for follow-up on your feedback.")
          .font(.footnote)
          .foregroundColor(Theme.inkDim)
          .multilineTextAlignment(.center)
          .padding(.horizontal, 8)
        VStack(spacing: 22) {
          VStack(spacing: 6) {
            TextField("Name", text: $profileName)
              .textFieldStyle(.plain)
              .foregroundColor(Theme.ink)
            Hairline()
          }
          VStack(spacing: 6) {
            TextField("Phone (optional)", text: $profilePhone)
              .textFieldStyle(.plain)
              .keyboardType(.phonePad)
              .foregroundColor(Theme.ink)
            Hairline()
          }
        }
        .padding(.vertical, 6)

        Button(profileName.isEmpty ? "Skip for now" : "Let's go") { showProfile = false }
          .buttonStyle(PulseButtonStyle())
      }
      .padding(26)
    }
    .presentationDetents([.medium])
    .preferredColorScheme(.light)
  }
}
