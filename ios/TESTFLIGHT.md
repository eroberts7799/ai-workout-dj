# TestFlight — the 15-minute path

The archive already builds (`build/AwdjPlayer.xcarchive`, verified). What's
left needs Ethan's Apple ID — none of it is automatable without your login.

## One-time setup (~10 min, needs you)

1. **App Store Connect record** — appstoreconnect.apple.com → My Apps → “+” →
   New App:
   - Platform iOS, Name “AI Workout DJ”, Bundle ID `com.ethanroberts.awdjplayer`
     (register it at developer.apple.com → Identifiers if it's not in the list),
     SKU `awdj-1`.
2. **Xcode sign-in** — Xcode → Settings → Accounts → add `eroberts7799@gmail.com`
   so the enrolled team's distribution signing is available. If the paid team has
   a different Team ID than `6N9T4GRA6U`, update `DEVELOPMENT_TEAM` in
   `project.yml` and re-run `xcodegen`.

## Every upload (~5 min, mostly automated)

```sh
cd ios && xcodegen
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
  xcodebuild -project AwdjPlayer.xcodeproj -scheme AwdjPlayer \
  -destination 'generic/platform=iOS' -archivePath build/AwdjPlayer.xcarchive archive
# Then: Xcode → Window → Organizer → Archives → Distribute App → TestFlight & App Store.
# (CLI alternative once an App Store Connect API key exists:
#  xcodebuild -exportArchive with method app-store-connect + notarize via altool successor.)
```

3. **Testers** — App Store Connect → TestFlight tab → Internal Testing → add
   yourself; External Testing group for friends (first external build needs a
   short beta review, usually <24h).

## Blockers to know

- **Demo audio**: TestFlight builds for friends can't ship copyrighted tracks.
  Bundle a royalty-free demo library (3–5 tracks, analyzed + tagged) before the
  first external build. Internal testing (you) has no such issue — your songs
  arrive via iCloud Drive import, not the bundle.
- **Background audio** is already declared (`UIBackgroundModes: [audio]`).
- Version/build numbers: bump `CFBundleShortVersionString`/`CFBundleVersion`
  per upload (add to project.yml settings when we automate this).
