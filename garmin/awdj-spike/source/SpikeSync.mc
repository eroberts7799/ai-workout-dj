// Sync: three real crate mp3s pulled over wifi from the Mac's dev server
// (/api/library/audio streams audio/mpeg — the same route the Tagger
// uses). URLs are baked for the current LAN (rule: rebuild if
// `ipconfig getifaddr en0` changes — the data field taught us this).

using Toybox.Application;
using Toybox.Communications;
using Toybox.Media;

module SpikeSongs {
    const BASE = "http://192.168.1.179:5173/api/library/audio/";
    const FILES = [
        "Absolutely%2C%20John%20Summit%20-%20DON_T%20BELIEVE%20IT%20(Extended%20Mix).mp3",
        "Beam%2C%20Skin%20On%20Skin%2C%20Fred%20again..%20-%20the%20floor%20(skin%20on%20skin%20remix).mp3",
        "Blanco%2C%20Kettama%2C%20Fred%20again..%20-%20solo%20(KETTAMA%20remix).mp3",
    ];
}

class SpikeSyncDelegate extends Media.SyncDelegate {

    private var mQueue;
    private var mTotal;

    function initialize() {
        SyncDelegate.initialize();
        mQueue = [];
    }

    function isSyncNeeded() {
        return SpikeLog.cachedCount() < SpikeSongs.FILES.size();
    }

    function onStartSync() {
        mQueue = [];
        for (var i = 0; i < SpikeSongs.FILES.size(); i++) {
            mQueue.add(SpikeSongs.BASE + SpikeSongs.FILES[i]);
        }
        mTotal = mQueue.size();
        SpikeLog.log("sync.start", "queue=" + mTotal);
        syncNext();
    }

    function syncNext() {
        if (mQueue.size() == 0) {
            SpikeLog.log("sync.done", "cached=" + SpikeLog.cachedCount());
            Media.notifySyncComplete(null);
            return;
        }
        var url = mQueue[0];
        var options = {
            :method => Communications.HTTP_REQUEST_METHOD_GET,
            :responseType => Communications.HTTP_RESPONSE_CONTENT_TYPE_AUDIO,
            :mediaEncoding => Media.ENCODING_MP3,
        };
        Communications.makeWebRequest(url, null, options, method(:onDownloaded));
    }

    function onDownloaded(responseCode, data) {
        if (responseCode == 200) {
            mQueue = mQueue.slice(1, mQueue.size());
            SpikeLog.log("sync.got", "remaining=" + mQueue.size());
            Media.notifySyncProgress(((mTotal - mQueue.size()) * 100) / mTotal);
            syncNext();
        } else {
            SpikeLog.log("sync.fail", "code=" + responseCode);
            Media.notifySyncComplete("download failed: " + responseCode);
        }
    }
}
