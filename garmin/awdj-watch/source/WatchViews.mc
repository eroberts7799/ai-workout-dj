// Views, with every lesson from the spike baked in: opening the app with
// an empty cache auto-syncs; START hands off to the system player.

using Toybox.Application.Storage;
using Toybox.Graphics;
using Toybox.Media;
using Toybox.WatchUi;

// The media CACHE is truth, not our Storage bookkeeping — count what the
// system will actually play (a desync between the two showed up as a
// "media error" on the first desk test).
function cachedAudioCount() {
    var n = 0;
    var iter = Media.getContentRefIter({:contentType => Media.CONTENT_TYPE_AUDIO});
    if (iter != null) {
        while (iter.next() != null) { n++; }
    }
    return n;
}

class WatchStatusDelegate extends WatchUi.BehaviorDelegate {
    function initialize() {
        BehaviorDelegate.initialize();
    }

    function onSelect() {
        if (cachedAudioCount() == 0) {
            Toybox.System.println("AWDJ play | refused: cache empty");
            return true;
        }
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
        flushDecisionLog();
        var n = cachedAudioCount();
        var tagged = Storage.getValue("songs");
        if (n == 0) {
            if (WatchServer.manifestUrl() == null) {
                mText = "AWDJ\nset crate manifest URL\nin Garmin Connect settings";
            } else {
                mText = "AWDJ\nsyncing crate...";
                Media.startSync();
            }
        } else {
            mText = "AWDJ\n" + n + " songs cached (" + (tagged != null ? tagged.size() : 0) + " tagged)\npress START to play";
        }
    }

    // The flywheel intake: buffered picks/skips POST to the relay via the
    // phone's connection (few KB — no wifi window needed). Cleared only on
    // a confirmed 201, so a dead zone just means next time.
    function flushDecisionLog() {
        var log = Storage.getValue("declog");
        var url = Storage.getValue("logUrl");
        if (log == null || log.size() == 0 || url == null) { return; }
        Toybox.Communications.makeWebRequest(
            url,
            {"name" => "watch-decisions", "source" => "watch", "decisions" => log},
            {:method => Toybox.Communications.HTTP_REQUEST_METHOD_POST,
             :headers => {"Content-Type" => Toybox.Communications.REQUEST_CONTENT_TYPE_JSON},
             :responseType => Toybox.Communications.HTTP_RESPONSE_CONTENT_TYPE_JSON},
            method(:onLogFlushed)
        );
    }

    function onLogFlushed(responseCode, data) {
        if (responseCode == 201) {
            Storage.setValue("declog", []);
            Toybox.System.println("AWDJ log | flushed to relay");
        } else {
            Toybox.System.println("AWDJ log | flush failed code=" + responseCode + " (kept)");
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
