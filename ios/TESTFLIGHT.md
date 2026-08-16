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

## Every upload (~5 min, fully CLI — no Xcode UI, proven builds 1–6)

```sh
cd ios
# 1. bump CURRENT_PROJECT_VERSION in project.yml, then:
xcodegen
# 2. archive (cloud signing via the ASC Admin key in .asc/):
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
  xcodebuild -project AwdjPlayer.xcodeproj -scheme AwdjPlayer \
  -destination 'generic/platform=iOS' -archivePath build/AwdjPlayer.xcarchive \
  -allowProvisioningUpdates \
  -authenticationKeyPath "$PWD/.asc/AuthKey_R8827W4635.p8" \
  -authenticationKeyID R8827W4635 \
  -authenticationKeyIssuerID 2ea54037-c0ac-4593-9fe7-3ce2dd7ccafb archive
# 3. export + upload straight to App Store Connect:
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
  xcodebuild -exportArchive -archivePath build/AwdjPlayer.xcarchive \
  -exportOptionsPlist ExportOptions.plist -allowProvisioningUpdates \
  -authenticationKeyPath "$PWD/.asc/AuthKey_R8827W4635.p8" \
  -authenticationKeyID R8827W4635 \
  -authenticationKeyIssuerID 2ea54037-c0ac-4593-9fe7-3ce2dd7ccafb
# Internal testers get it automatically after ~5-15 min of processing
# (ITSAppUsesNonExemptEncryption=false is declared — no compliance prompt).
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
