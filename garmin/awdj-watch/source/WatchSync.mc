// Sync: manifest first (which songs + their BPM/key/title), then audio.
// The dev server's /api/library serves both. Baked LAN IP — rebuild when
// `ipconfig getifaddr en0` changes (the tax we keep paying knowingly).

using Toybox.Application.Storage;
using Toybox.Communications;
using Toybox.Media;
using Toybox.System;

module WatchServer {
    const BASE = "http://192.168.1.179:5173/api/library/";
    const MANIFEST_LIMIT = 15; // ~170MB of audio — keep first syncs sane
}

class WatchSyncDelegate extends Media.SyncDelegate {

    private var mQueue; // [{ "file" =>, "bpm" =>, "camelot" =>, "title" =>, "durationMs" => }]
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
        System.println("AWDJ sync | fetching manifest");
        Communications.makeWebRequest(
            WatchServer.BASE + "watch-manifest",
            {"limit" => WatchServer.MANIFEST_LIMIT},
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
            WatchServer.BASE + "audio/" + t["file"],
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
        // The Brain's lookup: refId → [bpm, camelot, title, durationMs]
        var songs = Storage.getValue("songs");
        if (songs == null) { songs = {}; }
        songs[data.getId()] = [t["bpm"], t["camelot"], t["title"], t["durationMs"]];
        Storage.setValue("songs", songs);
        System.println("AWDJ sync | got " + t["title"] + " (" + mQueue.size() + " left)");
        Media.notifySyncProgress(((mTotal - mQueue.size()) * 100) / mTotal);
        syncNext();
    }
}
