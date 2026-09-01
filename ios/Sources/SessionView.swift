// The pocket conductor's session screen: import bundle + audio once,
// arm, press start on the watch, run.
import SwiftUI
import UniformTypeIdentifiers

struct SessionView: View {
  @StateObject private var engine = SessionEngine()
  @StateObject private var relay = RelayPoller()
  @State private var showBundlePicker = false
  @State private var showAudioPicker = false
  @AppStorage("awdj.profileName") private var profileName = ""
  @AppStorage("awdj.profilePhone") private var profilePhone = ""
  @State private var showProfile = false
  @ObservedObject private var spotify = SpotifyAuth.shared
  @ObservedObject private var bleHr = BleHeartRate.shared
  @State private var showClientIdPrompt = false
  @State private var clientIdText = ""
  @State private var showPlaylistPrompt = false
  @State private var playlistLinkText = ""
  @State private var showPlaylistSheet = false
  @State private var showPreview = false
  @State private var previewRows: [SessionEngine.PreviewRow] = []
  @State private var myPlaylists: [SpotifyLibrary.PlaylistRef] = []

  @State private var showMenu = false

  var body: some View {
    ZStack(alignment: .leading) {
      mainContent
      if showMenu {
        Color.black.opacity(0.35)
          .ignoresSafeArea()
          .onTapGesture { withAnimation { showMenu = false } }
        sideMenu
          .transition(.move(edge: .leading))
      }
    }
    .animation(.easeOut(duration: 0.2), value: showMenu)
  }

  private var mainContent: some View {
    // ScrollView, not bare VStack: a 44-track crate's readiness list overflows
    // any screen — without scrolling, the import buttons become unreachable
    // (build 7 froze exactly this way the first time a real bundle landed).
    ScrollView {
    VStack(spacing: 20) {
      ZStack(alignment: .topLeading) {
        if engine.phase == .idle {
          Button { withAnimation { showMenu = true } } label: {
            Label("MENU", systemImage: "line.3.horizontal")
              .font(.system(size: 13, weight: .bold, design: .monospaced))
              .foregroundColor(Theme.faded)
          }
        }
        Text("AWDJ")
          .fieldDisplay(30)
          .textCase(.uppercase)
          .frame(maxWidth: .infinity)
      }

      switch engine.phase {
      case .idle:
        // The launcher, not a control panel (Ethan, 2026-08-25: "too many
        // words and buttons"). One primary CTA, one picker, one menu.
        if let b = engine.bundle {
          Text("\(b.name)\(b.tags != nil ? " · \(b.tags!.count) songs" : "")")
            .fieldSubhead()
            .textCase(.uppercase)
        }
        // Problems only — health is silence.
        if let b = engine.bundle, engine.musicSource == .ownedFiles {
          let missing = b.songs.filter { engine.audioReady[$0.trackId] != true }
          if !missing.isEmpty {
            Text("\(missing.count) songs missing audio — import audio files")
              .fieldMono(12, weight: .bold)
              .foregroundColor(Theme.fail)
          }
        }
        if engine.musicSource == .spotify && !spotify.connected {
          Button("Connect Spotify") {
            if (spotify.clientId ?? "").isEmpty {
              showClientIdPrompt = true
            } else {
              spotify.login { err in if let err { engine.status = err } }
            }
          }
          .buttonStyle(ArmButtonStyle())
        } else {
          // READY state, not a control panel: the 9/1 Rolling 800s failed
          // because the big in-app START button launched TRAIL mode over a
          // loaded structured plan. The app now presets everything and the
          // only start that exists is the watch's. Trail lives in the menu.
          if let w = engine.workoutName, let steps = engine.bundle?.plan, !steps.isEmpty {
            Text("TODAY").fieldMono(11, weight: .bold).foregroundColor(Theme.faded)
            Text(w).fieldDisplay(22).textCase(.uppercase)
            let hard = steps.filter { $0.kind == "hard" }.count
            let km = steps.compactMap { $0.meters }.reduce(0, +) / 1000
            Text(String(format: "%.1f km · %d efforts", km, hard))
              .fieldMono(12)
              .foregroundColor(Theme.faded)
          }
          Text("PRESS START ON YOUR WATCH")
            .fieldMono(14, weight: .bold)
            .foregroundColor(Theme.olive)
          if engine.musicSource == .spotify {
            Text("open Spotify & press play first — then it takes over")
              .fieldMono(11)
              .foregroundColor(Theme.faded)
          }
        }
        Button("Select playlist") {
          engine.status = "loading your playlists…"
          Task {
            do {
              myPlaylists = try await SpotifyLibrary.myPlaylists()
              showPlaylistSheet = true
              engine.status = ""
            } catch {
              engine.status = "couldn't list playlists — paste a link instead"
              showPlaylistPrompt = true
            }
          }
        }
        .buttonStyle(FieldButtonStyle())
        .disabled(!spotify.connected)
        if engine.bundle?.tags?.isEmpty == false {
          Button("Preview the mix") {
            previewRows = engine.previewSetlist()
            showPreview = true
          }
          .buttonStyle(FieldButtonStyle(color: Theme.faded))
        }
        if relay.fresh {
          Text("watch connected — press START on the watch for a planned workout")
            .fieldMono(12)
            .foregroundColor(Theme.olive)
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

      if !engine.status.isEmpty {
        Text(engine.status).fieldMono(11).foregroundColor(Theme.faded)
      }
    }
    .padding()
    // Two .fileImporter on ONE view = only one works (paid for on 8/11) —
    // bundle importer here, audio importer on the outer ScrollView.
    .fileImporter(isPresented: $showBundlePicker, allowedContentTypes: [.json]) { result in
      if case .success(let url) = result { engine.importBundle(from: url) }
    }
    }
    .fileImporter(isPresented: $showAudioPicker, allowedContentTypes: [.audio], allowsMultipleSelection: true) { result in
      if case .success(let urls) = result { engine.importAudio(from: urls) }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(Theme.paper.ignoresSafeArea())
    .foregroundColor(Theme.ink)
    .tint(Theme.olive)
    .sheet(isPresented: $showPreview) {
      NavigationView {
        List(previewRows) { r in
          HStack(alignment: .top, spacing: 12) {
            Text(String(format: "%.0f min", r.atMin))
              .font(.system(size: 13, weight: .bold, design: .monospaced))
              .foregroundColor(r.reason.contains("rep change") || r.reason.contains("drop") ? Theme.olive : Theme.faded)
              .frame(width: 54, alignment: .leading)
            Text(r.reason)
              .font(.system(size: 14))
          }
        }
        .navigationTitle("What the DJ will do")
        .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { showPreview = false } } }
      }
    }
    .sheet(isPresented: $showPlaylistSheet) {
      NavigationView {
        List(myPlaylists) { p in
          Button {
            showPlaylistSheet = false
            engine.status = "importing \(p.name)…"
            Task {
              do {
                let (name, tags) = try await SpotifyLibrary.playlistTracks(id: p.id, name: p.name)
                engine.adoptLibrary(name: name, tags: tags)
              } catch { engine.status = "import failed: \(error.localizedDescription)" }
            }
          } label: {
            HStack {
              Text(p.name)
              Spacer()
              Text("\(p.trackCount)").foregroundColor(.secondary)
            }
          }
        }
        .navigationTitle("Your playlists")
      }
    }
    .alert("Playlist link", isPresented: $showPlaylistPrompt) {
      TextField("Paste a Spotify playlist link", text: $playlistLinkText)
      Button("Import") {
        let link = playlistLinkText.trimmingCharacters(in: .whitespaces)
        engine.status = "importing playlist…"
        Task {
          do {
            let (name, tags) = try await SpotifyLibrary.scrapePlaylist(link: link)
            engine.adoptLibrary(name: name, tags: tags)
          } catch { engine.status = "playlist import failed: \(error.localizedDescription)" }
        }
      }
      Button("Cancel", role: .cancel) {}
    } message: {
      Text("Public playlists only (first 100 tracks). The conductor tags what it recognizes.")
    }
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
      Task {
        await SpotifyLibrary.refreshTagTable()
        // Preset ready: library wired (Free Play default), workout loaded,
        // app held awake — the morning ritual is the watch's START button.
        await engine.prepareForToday(spotifyConnected: spotify.connected)
        if spotify.connected { await SpotifyLibrary.captureTasteSnapshot() }
      }
      relay.onSample = { [weak engine] s in
        guard let engine else { return }
        engine.handleGarmin(event: s.event, timerMs: s.timerMs, receivedAt: s.receivedAt, armed: true)
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

  // Side drawer: distinct sections, everything non-essential (Ethan
  // 2026-08-25: "side bar menu with distinct sections").
  private var sideMenu: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack {
        Text("AWDJ").fieldDisplay(20).textCase(.uppercase)
        Spacer()
        Button { withAnimation { showMenu = false } } label: {
          Text("CLOSE").fieldMono(12, weight: .bold).foregroundColor(Theme.faded)
        }
      }
      .padding(.horizontal, 20)
      .padding(.vertical, 16)
      List {
        Section("Music") {
          Picker("Source", selection: $engine.musicSource) {
            Text("Spotify").tag(SessionEngine.MusicSource.spotify)
            Text("Owned files").tag(SessionEngine.MusicSource.ownedFiles)
          }
          .pickerStyle(.segmented)
          Button("Free play — my whole taste") {
            withAnimation { showMenu = false }
            engine.status = "building your free-play crate…"
            Task {
              do {
                let tags = try await SpotifyLibrary.freeCrate { engine.status = $0 }
                engine.adoptLibrary(name: SpotifyLibrary.freeCrateName, tags: tags)
              } catch { engine.status = "free play failed: \(error.localizedDescription)" }
            }
          }
          Button("Liked Songs") {
            withAnimation { showMenu = false }
            engine.status = "importing Liked Songs…"
            Task {
              do {
                let tags = try await SpotifyLibrary.likedSongs()
                engine.adoptLibrary(name: "Liked Songs", tags: tags)
              } catch { engine.status = "Liked Songs failed: \(error.localizedDescription)" }
            }
          }
          Button("Paste a playlist link") {
            withAnimation { showMenu = false }
            showPlaylistPrompt = true
          }
        }
        Section("Workouts") {
          Button("Today's workout (from Garmin)") {
            withAnimation { showMenu = false }
            engine.loadNextWorkout()
          }
          Button("Trail run (phone only, no watch)") {
            withAnimation { showMenu = false }
            engine.startTrailRun()
          }
          // One tap: the program loads and counts itself down.
          ForEach(SessionEngine.builtinPrograms, id: \.resource) { p in
            Button(p.title) {
              withAnimation { showMenu = false }
              engine.loadBuiltin(p.resource)
              engine.status = "\(p.title) — starting in 3s"
              DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
                if engine.phase == .idle { engine.start(atOffsetMs: 0) }
              }
            }
          }
        }
        Section("Advanced") {
          Button("Import bundle") {
            withAnimation { showMenu = false }
            showBundlePicker = true
          }
          Button("Import audio files") {
            withAnimation { showMenu = false }
            showAudioPicker = true
          }
          Menu("Simulate run") {
            ForEach([1.0, 2.0, 4.0, 8.0], id: \.self) { s in
              Button("×\(Int(s))\(s == 1 ? " (dress rehearsal)" : "")") {
                withAnimation { showMenu = false }
                engine.startSimulatedRun(speed: s)
              }
            }
          }
          Button("Reconnect Spotify") {
            withAnimation { showMenu = false }
            if (spotify.clientId ?? "").isEmpty {
              showClientIdPrompt = true
            } else {
              spotify.login { err in if let err { engine.status = err } }
            }
          }
          Button("Athlete profile") {
            withAnimation { showMenu = false }
            showProfile = true
          }
        }
      }
      .listStyle(.insetGrouped)
      .scrollContentBackground(.hidden)
    }
    .frame(width: 300)
    .frame(maxHeight: .infinity)
    .background(Theme.paper)
    .foregroundColor(Theme.ink)
  }
}
