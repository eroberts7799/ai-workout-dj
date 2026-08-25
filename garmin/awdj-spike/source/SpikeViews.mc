// Minimal views: the sync-config view kicks a sync the moment it opens
// (no server listing, no checkboxes — the song list is baked); the
// playback-config view just reports cache state.

using Toybox.Graphics;
using Toybox.Media;
using Toybox.WatchUi;

// START/SELECT hands off to the system player: startPlayback exits the
// config context and the player drives our ContentIterator.
class SpikeStatusDelegate extends WatchUi.BehaviorDelegate {
    function initialize() {
        BehaviorDelegate.initialize();
    }

    function onSelect() {
        SpikeLog.log("statusView.play", "startPlayback");
        Media.startPlayback(null);
        return true;
    }
}

class SpikeStatusView extends WatchUi.View {
    private var mText;

    function initialize(text) {
        View.initialize();
        mText = text;
    }

    // Foolproofing: Garmin's menu routing to the sync view differs by
    // device — if the user lands HERE with an empty cache, just sync.
    function onShow() {
        if (SpikeLog.cachedCount() == 0) {
            SpikeLog.log("statusView.autosync", "cache empty");
            mText = "AWDJ Spike\nsyncing 3 songs...\nMac dev server + wifi required";
            Media.startSync();
        }
    }

    function onUpdate(dc) {
        dc.setColor(Graphics.COLOR_BLACK, Graphics.COLOR_BLACK);
        dc.clear();
        dc.setColor(Graphics.COLOR_WHITE, Graphics.COLOR_BLACK);
        dc.drawText(dc.getWidth() / 2, dc.getHeight() / 2, Graphics.FONT_SMALL, mText,
            Graphics.TEXT_JUSTIFY_CENTER | Graphics.TEXT_JUSTIFY_VCENTER);
    }
}

class SpikeSyncView extends WatchUi.View {

    function initialize() {
        View.initialize();
    }

    function onShow() {
        SpikeLog.log("syncView.show", "requesting sync");
        Media.startSync();
    }

    function onUpdate(dc) {
        dc.setColor(Graphics.COLOR_BLACK, Graphics.COLOR_BLACK);
        dc.clear();
        dc.setColor(Graphics.COLOR_WHITE, Graphics.COLOR_BLACK);
        dc.drawText(dc.getWidth() / 2, dc.getHeight() / 2, Graphics.FONT_SMALL,
            "AWDJ Spike sync\nMac dev server must be up\n(3 songs over wifi)",
            Graphics.TEXT_JUSTIFY_CENTER | Graphics.TEXT_JUSTIFY_VCENTER);
    }
}
