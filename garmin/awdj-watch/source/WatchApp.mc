// AWDJ on the wrist — the first sensor-driven music selector on a Garmin.
// Audio content provider: syncs the crate (audio + BPM/key metadata) from
// the Mac over wifi, then picks every next song by the body's live state.

using Toybox.Application;
using Toybox.Media;

class WatchApp extends Application.AudioContentProviderApp {

    function initialize() {
        AudioContentProviderApp.initialize();
    }

    function getContentDelegate(args) {
        return new WatchContentDelegate();
    }

    function getSyncDelegate() {
        return new WatchSyncDelegate();
    }

    function getPlaybackConfigurationView() {
        return [
            new WatchStatusView(),
            new WatchStatusDelegate(),
        ];
    }

    function getSyncConfigurationView() {
        return [new WatchSyncView()];
    }
}
