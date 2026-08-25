// Views, with every lesson from the spike baked in: opening the app with
// an empty cache auto-syncs; START hands off to the system player.

using Toybox.Application.Storage;
using Toybox.Graphics;
using Toybox.Media;
using Toybox.WatchUi;

class WatchStatusDelegate extends WatchUi.BehaviorDelegate {
    function initialize() {
        BehaviorDelegate.initialize();
    }

    function onSelect() {
        Media.startPlayback(null);
        return true;
    }
}

class WatchStatusView extends WatchUi.View {
    private var mText;

    function initialize() {
        View.initialize();
        mText = "";
    }

    function onShow() {
        var songs = Storage.getValue("songs");
        var n = songs != null ? songs.size() : 0;
        if (n == 0) {
            mText = "AWDJ\nsyncing crate...\nMac server + wifi required";
            Media.startSync();
        } else {
            mText = "AWDJ\n" + n + " songs on wrist\npress START to play";
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

class WatchSyncView extends WatchUi.View {

    function initialize() {
        View.initialize();
    }

    function onShow() {
        Media.startSync();
    }

    function onUpdate(dc) {
        dc.setColor(Graphics.COLOR_BLACK, Graphics.COLOR_BLACK);
        dc.clear();
        dc.setColor(Graphics.COLOR_WHITE, Graphics.COLOR_BLACK);
        dc.drawText(dc.getWidth() / 2, dc.getHeight() / 2, Graphics.FONT_SMALL,
            "AWDJ crate sync\nMac dev server must be up",
            Graphics.TEXT_JUSTIFY_CENTER | Graphics.TEXT_JUSTIFY_VCENTER);
    }
}
