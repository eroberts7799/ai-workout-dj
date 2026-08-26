// Media delegate + iterator: the pull model with the Brain at the wheel.
// The player asks; the Brain reads the body and answers.

using Toybox.Media;
using Toybox.System;

class WatchContentDelegate extends Media.ContentDelegate {

    private var mIterator;
    private var mEvents = ["Start", "SkipNext", "SkipPrev", "Notify", "Complete", "Stop", "Pause", "Resume", "SkipFwd", "SkipBack"];

    function initialize() {
        ContentDelegate.initialize();
        mIterator = new WatchContentIterator();
    }

    function getContentIterator() {
        return mIterator;
    }

    // Explicit taste votes — the strongest signal the flywheel has.
    function onThumbsUp(refId) {
        var m = Brain.meta(refId);
        Brain.record({"e" => "thumbsUp", "song" => m != null ? m[2] : "?"});
    }

    function onThumbsDown(refId) {
        var m = Brain.meta(refId);
        Brain.record({"e" => "thumbsDown", "song" => m != null ? m[2] : "?"});
    }

    function resetContentIterator() {
        mIterator = new WatchContentIterator();
        return mIterator;
    }

    function onSong(refId, songEvent, playbackPosition) {
        var name = songEvent >= 0 && songEvent < mEvents.size() ? mEvents[songEvent] : "evt" + songEvent;
        System.println("AWDJ onSong | " + name + " pos=" + playbackPosition);
        // The model never argues with the speaker: whatever ACTUALLY starts
        // is the current song, no matter what we planned (first desk test:
        // skip restarted the current track while the Brain "picked" another).
        if (songEvent == Media.SONG_EVENT_START) {
            mIterator.noteStarted(refId);
            var m = Brain.meta(refId);
            Brain.record({"e" => "start", "song" => m != null ? m[2] : "?"});
        }
        // A manual skip is a thumbs-down on what was playing — same doctrine
        // as the phone tier's SkipEvent, buffered for the relay upload.
        if (songEvent == Media.SONG_EVENT_SKIP_NEXT) {
            System.println("AWDJ skip | user overruled at pos=" + playbackPosition);
            Brain.record({"e" => "skip", "pos" => playbackPosition});
        }
    }
}

class WatchContentIterator extends Media.ContentIterator {

    private var mIds;
    private var mCurrent;
    // The committed plan for what plays next. peekNext() and next() MUST
    // agree — the system player preloads from peekNext, and a mismatch with
    // next() makes it restart the current track (first desk test).
    private var mPlanned;

    function initialize() {
        ContentIterator.initialize();
        mIds = [];
        mCurrent = null;
        mPlanned = null;
        var iter = Media.getContentRefIter({:contentType => Media.CONTENT_TYPE_AUDIO});
        if (iter != null) {
            var ref = iter.next();
            while (ref != null) {
                mIds.add(ref.getId());
                ref = iter.next();
            }
        }
        System.println("AWDJ iterator | songs=" + mIds.size());
    }

    function getPlaybackProfile() {
        var profile = new Media.PlaybackProfile();
        // Ethan's 4-slot spec (BACK is the physical button, not a slot):
        // play/pause · next · volume · menu. No PREVIOUS (the Brain only
        // picks forward — its triangle doubled the play glyph). LIBRARY
        // opens AWDJ's own screen. Skips still log as the taste signal;
        // explicit thumbs can return later as a setting.
        profile.playbackControls = [
            Media.PLAYBACK_CONTROL_PLAYBACK,
            Media.PLAYBACK_CONTROL_NEXT,
            Media.PLAYBACK_CONTROL_VOLUME,
            Media.PLAYBACK_CONTROL_LIBRARY,
        ];
        profile.requirePlaybackNotification = false;
        return profile;
    }

    private function obj(id) {
        if (id == null) { return null; }
        return Media.getCachedContentObj(new Media.ContentRef(id, Media.CONTENT_TYPE_AUDIO));
    }

    // Plan once, answer consistently: the Brain decides at first ask
    // (peek OR next), and both return that same committed plan.
    private function planned() {
        if (mPlanned == null) {
            mPlanned = Brain.pickNext(mCurrent, mIds);
        }
        return mPlanned;
    }

    // The player reports what actually started — adopt it and re-plan.
    function noteStarted(refId) {
        mCurrent = refId;
        mPlanned = null;
    }

    // The boundary. Consume the plan (making one if the player never peeked).
    function next() {
        var pick = planned();
        if (pick == null) { return null; }
        mCurrent = pick;
        mPlanned = null;
        return obj(pick);
    }

    function previous() {
        // "Previous" = most recent from the Brain's memory, else stay.
        if (Brain.recentIds.size() >= 2) {
            mCurrent = Brain.recentIds[Brain.recentIds.size() - 2];
        }
        mPlanned = null;
        return obj(mCurrent);
    }

    function get() {
        if (mCurrent == null && mIds.size() > 0) {
            mCurrent = Brain.pickNext(null, mIds);
        }
        return obj(mCurrent);
    }

    function peekNext() {
        var pick = planned();
        return pick != null ? obj(pick) : null;
    }

    function peekPrevious() {
        return obj(mCurrent);
    }

    function shuffling() {
        return false;
    }

    function canSkip() {
        return true;
    }
}
