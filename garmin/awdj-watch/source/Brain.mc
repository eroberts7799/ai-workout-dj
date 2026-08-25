// The watch-tier brain — sensor-driven selection at song boundaries.
// NOT a port of LiveEngine (two brains already; a third full engine would
// be reckless). This is the deliberately minimal boundary-mode core: at
// every "what's next?" callback, read the body (timer/HR/altitude from
// the live activity — proven by the 8/25 spike), score candidates, pick.
// Ledgered as a REDUCED surface in ios/PARITY.md.
//
// mixScore/camelotCompatible mirror src/conductor/beat.ts exactly.

using Toybox.Activity;
using Toybox.Application.Storage;
using Toybox.System;

module Brain {

    // Per-athlete anchor — hr_calibration.py over 2,616 activities (Ethan).
    // TODO: ship in the manifest per athlete when this leaves Ethan's wrist.
    const HR_MAX = 197.0;
    // Altitude gain between boundaries that reads as "on a climb". A
    // boundary-mode stand-in for GradeTracker (which needs 1Hz samples we
    // don't get) — GUESS until real watch runs tune it.
    const CLIMB_GAIN_M = 8.0;

    // Selection state across callbacks (module vars live with the app).
    var lastAltitudeM = null;
    var recentIds = [];

    // Storage["songs"]: { refId => [bpm, camelot, title, durationMs] }
    function meta(refId) {
        var songs = Storage.getValue("songs");
        if (songs == null) { return null; }
        return songs[refId];
    }

    // "3A" → [3, 'A'] — no regex in Monkey C; parse by hand, null on junk.
    function parseCamelot(c) {
        if (c == null || !(c instanceof Toybox.Lang.String)) { return null; }
        var len = c.length();
        if (len < 2 || len > 3) { return null; }
        var num = c.substring(0, len - 1).toNumber();
        var letter = c.substring(len - 1, len).toUpper();
        if (num == null || num < 1 || num > 12) { return null; }
        if (!letter.equals("A") && !letter.equals("B")) { return null; }
        return [num, letter];
    }

    // Mirrors beat.ts camelotCompatible: same slot, or ±1 on the wheel in
    // the same letter ring. Unknown keys are permissive.
    function camelotCompatible(a, b) {
        var pa = parseCamelot(a);
        var pb = parseCamelot(b);
        if (pa == null || pb == null) { return true; }
        if (pa[0] == pb[0]) { return true; }
        var d = (pa[0] - pb[0]).abs();
        if (12 - d < d) { d = 12 - d; }
        return d == 1 && pa[1].equals(pb[1]);
    }

    // Mirrors beat.ts mixScore: +2 tempos within 3%, +1 compatible keys
    // (only when both actually known).
    function mixScore(fromMeta, toMeta) {
        var s = 0;
        if (fromMeta != null && toMeta != null) {
            var fb = fromMeta[0];
            var tb = toMeta[0];
            if (fb != null && tb != null && fb > 0) {
                var ratio = tb.toFloat() / fb.toFloat();
                var dev = (1.0 - ratio).abs();
                if (dev <= 0.03) { s += 2; }
            }
            if (fromMeta[1] != null && toMeta[1] != null && camelotCompatible(fromMeta[1], toMeta[1])) { s += 1; }
        }
        return s;
    }

    function hrZone(info) {
        if (info == null || info.currentHeartRate == null) { return 0; }
        var pct = info.currentHeartRate / HR_MAX;
        if (pct < 0.6) { return 1; }
        if (pct < 0.7) { return 2; }
        if (pct < 0.8) { return 3; }
        if (pct < 0.9) { return 4; }
        return 5;
    }

    // The watch knows the Runna plan natively (same API the data field
    // streams to the phone). Boundary-mode plan awareness: are we IN a hard
    // step, or is the NEXT one hard (the song chosen now will be playing
    // when it starts)? Intensity map mirrors AwdjField.kindOf.
    function effortContext() {
        var inHard = false;
        var nextHard = false;
        var cur = Activity.getCurrentWorkoutStep();
        if (cur != null && (cur.intensity == Activity.WORKOUT_INTENSITY_ACTIVE
            || cur.intensity == Activity.WORKOUT_INTENSITY_INTERVAL)) {
            inHard = true;
        }
        var nxt = Activity.getNextWorkoutStep();
        if (nxt != null && (nxt.intensity == Activity.WORKOUT_INTENSITY_ACTIVE
            || nxt.intensity == Activity.WORKOUT_INTENSITY_INTERVAL)) {
            nextHard = true;
        }
        return [inHard, nextHard];
    }

    // The moment of choice: score every cached candidate against what just
    // ended, with the body AND the plan as tiebreakers — a hard step now
    // (or next: this song will be playing when it starts), a climb, or
    // deep effort all prefer faster songs (bpm-as-energy is crude; honest v1).
    function pickNext(currentRefId, candidateIds) {
        var info = Activity.getActivityInfo();
        var zone = hrZone(info);
        var effort = effortContext();
        var wantsEnergy = effort[0] || effort[1] || zone >= 4;
        var climbing = false;
        if (info != null && info.altitude != null) {
            if (lastAltitudeM != null && info.altitude - lastAltitudeM >= CLIMB_GAIN_M) { climbing = true; }
            lastAltitudeM = info.altitude;
        }
        var cur = currentRefId != null ? meta(currentRefId) : null;
        var best = null;
        var bestScore = -999;
        for (var i = 0; i < candidateIds.size(); i++) {
            var id = candidateIds[i];
            if (currentRefId != null && id == currentRefId) { continue; }
            var m = meta(id);
            var score = mixScore(cur, m);
            if (recentIds.indexOf(id) >= 0) { score -= 1; }
            if ((wantsEnergy || climbing) && m != null && cur != null && m[0] != null && cur[0] != null && m[0] > cur[0]) { score += 1; }
            if (score > bestScore) { bestScore = score; best = id; }
        }
        if (best != null) {
            recentIds.add(best);
            if (recentIds.size() > 6) { recentIds = recentIds.slice(1, recentIds.size()); }
            var name = meta(best) != null ? meta(best)[2] : "?";
            System.println("AWDJ pick | " + name + " score=" + bestScore + " zone=" + zone + " climbing=" + climbing
                + " inHard=" + effort[0] + " nextHard=" + effort[1]
                + " | timer=" + (info != null ? info.timerTime : null) + " hr=" + (info != null ? info.currentHeartRate : null));
        }
        return best;
    }
}
