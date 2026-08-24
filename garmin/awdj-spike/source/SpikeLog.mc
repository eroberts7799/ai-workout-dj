// The whole point of the spike: every media callback logs the live
// activity state it can (or can't) see. One line per event, grep AWDJ.

using Toybox.Activity;
using Toybox.Media;
using Toybox.System;

module SpikeLog {

    // "timer=482000 dist=1204.5 hr=142 state=1" — or the null verdicts.
    function activityLine() {
        var info = Activity.getActivityInfo();
        if (info == null) {
            return "act=NULL";
        }
        var line = "timer=" + info.timerTime + " dist=" + info.elapsedDistance
            + " hr=" + info.currentHeartRate + " state=" + info.timerState;
        return line;
    }

    function log(where, detail) {
        System.println("AWDJ " + where + " | " + detail + " | " + activityLine());
    }

    function cachedCount() {
        var iter = Media.getContentRefIter({:contentType => Media.CONTENT_TYPE_AUDIO});
        var n = 0;
        if (iter != null) {
            while (iter.next() != null) { n++; }
        }
        return n;
    }
}
