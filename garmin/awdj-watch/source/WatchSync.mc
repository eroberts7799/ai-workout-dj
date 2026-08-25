// Sync: one setting rules everything. The manifest URL (editable from
// Garmin Connect on the phone — no rebuilds, no baked IPs) names the
// tracks, their audio URLs, their DJ tags, and where to report decisions.
// Point it at the Mac dev server or at the published cloud crate — the
// watch can't tell the difference, by design.

using Toybox.Application.Properties;
using Toybox.Application.Storage;
using Toybox.Communications;
using Toybox.Media;
using Toybox.System;

module WatchServer {
    // DEV DEFAULT — Ethan's cloud crate, so the sideloaded build works with
    // zero configuration (Garmin's phone settings editors don't reliably
    // show sideloaded apps). ⚠ STORE BUILDS MUST NULL THIS (STORE.md
    // checklist): shipping it would hand Ethan's purchased music to every
    // installer. Store users set their own manifest via app settings.
    const DEV_DEFAULT_MANIFEST = "https://xo5ag40y70msuxua.public.blob.vercel-storage.com/watch-crate/manifest-EENyhmbQVEsy8K1Z7CJf1gU4piOh5B.json";

    function manifestUrl() {
        var v = null;
        // Properties.getValue throws on unset in some SDK versions — guard.
        try {
            v = Properties.getValue("manifestUrl");
        } catch (e) {
            v = null;
        }
        if (v == null || !(v instanceof Toybox.Lang.String) || v.length() < 8) {
            return DEV_DEFAULT_MANIFEST;
        }
        return v;
    }
}

class WatchSyncDelegate extends Media.SyncDelegate {

    private var mQueue; // [{ "url" =>, "bpm" =>, "camelot" =>, "title" =>, "durationMs" => }]
    private var mTotal;

    function initialize() {
        SyncDelegate.initialize();
        mQueue = [];
        mTotal = 0;
    }

    function isSyncNeeded() {
        var songs = Storage.getValue("songs");
        return songs == null || songs.size() == 0;
    }

    function onStartSync() {
        var url = WatchServer.manifestUrl();
        if (url == null) {
            System.println("AWDJ sync | no manifest URL set");
            Media.notifySyncComplete("set the crate manifest URL in Garmin Connect app settings");
            return;
        }
        System.println("AWDJ sync | fetching manifest " + url);
        Communications.makeWebRequest(
            url,
            null,
            {:method => Communications.HTTP_REQUEST_METHOD_GET,
             :responseType => Communications.HTTP_RESPONSE_CONTENT_TYPE_JSON},
            method(:onManifest)
        );
    }

    function onManifest(responseCode, data) {
        if (responseCode != 200 || data == null || !(data instanceof Toybox.Lang.Dictionary)) {
            System.println("AWDJ sync | manifest failed code=" + responseCode);
            Media.notifySyncComplete("manifest failed: " + responseCode);
            return;
        }
        mQueue = data["tracks"];
        mTotal = mQueue.size();
        if (data["logUrl"] != null) { Storage.setValue("logUrl", data["logUrl"]); }
        System.println("AWDJ sync | manifest ok, " + mTotal + " tracks");
        syncNext();
    }

    function syncNext() {
        if (mQueue.size() == 0) {
            var songs = Storage.getValue("songs");
            System.println("AWDJ sync | done, cached=" + (songs != null ? songs.size() : 0));
            Media.notifySyncComplete(null);
            return;
        }
        var t = mQueue[0];
        Communications.makeWebRequest(
            t["url"],
            null,
            {:method => Communications.HTTP_REQUEST_METHOD_GET,
             :responseType => Communications.HTTP_RESPONSE_CONTENT_TYPE_AUDIO,
             :mediaEncoding => Media.ENCODING_MP3},
            method(:onDownloaded)
        );
    }

    function onDownloaded(responseCode, data) {
        if (responseCode != 200 || data == null) {
            System.println("AWDJ sync | download failed code=" + responseCode);
            Media.notifySyncComplete("download failed: " + responseCode);
            return;
        }
        var t = mQueue[0];
        mQueue = mQueue.slice(1, mQueue.size());
        var songs = Storage.getValue("songs");
        if (songs == null) { songs = {}; }
        songs[data.getId()] = [t["bpm"], t["camelot"], t["title"], t["durationMs"]];
        Storage.setValue("songs", songs);
        System.println("AWDJ sync | got " + t["title"] + " (" + mQueue.size() + " left)");
        Media.notifySyncProgress(((mTotal - mQueue.size()) * 100) / mTotal);
        syncNext();
    }
}
