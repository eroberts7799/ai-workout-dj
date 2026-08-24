// Minimal views: the sync-config view kicks a sync the moment it opens
// (no server listing, no checkboxes — the song list is baked); the
// playback-config view just reports cache state.

using Toybox.Graphics;
using Toybox.Media;
using Toybox.WatchUi;

class SpikeStatusView extends WatchUi.View {
    private var mText;

    function initialize(text) {
        View.initialize();
        mText = text;
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
