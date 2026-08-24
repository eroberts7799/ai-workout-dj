// AWDJ Spike — the gate for the watch-only tier.
// One question decides whether sensor-driven music selection can live on
// the watch: does Activity.getActivityInfo() return LIVE data (timer, HR,
// distance) when called from a media provider's callbacks while a native
// run activity records? Nothing in Garmin's docs answers it; this app
// logs the answer. Every callback the system gives us prints one
// grep-able AWDJ line to /GARMIN/APPS/LOGS/AWDJSPIKE.TXT.

using Toybox.Application;
using Toybox.Media;

class SpikeApp extends Application.AudioContentProviderApp {

    function initialize() {
        AudioContentProviderApp.initialize();
    }

    function getContentDelegate(args) {
        return new SpikeContentDelegate();
    }

    function getSyncDelegate() {
        return new SpikeSyncDelegate();
    }

    function getPlaybackConfigurationView() {
        return [new SpikeStatusView("AWDJ Spike\nsongs cached: " + SpikeLog.cachedCount() + "\nplay via watch music player")];
    }

    function getSyncConfigurationView() {
        return [new SpikeSyncView()];
    }
}
