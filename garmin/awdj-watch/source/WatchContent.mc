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

    function resetContentIterator() {
        mIterator = new WatchContentIterator();
        return mIterator;
    }

    function onSong(refId, songEvent, playbackPosition) {
        var name = songEvent >= 0 && songEvent < mEvents.size() ? mEvents[songEvent] : "evt" + songEvent;
        System.println("AWDJ onSong | " + name + " pos=" + playbackPosition);
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

    function initialize() {
        ContentIterator.initialize();
        mIds = [];
        mCurrent = null;
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
        profile.playbackControls = [
            Media.PLAYBACK_CONTROL_PLAYBACK,
            Media.PLAYBACK_CONTROL_PREVIOUS,
            Media.PLAYBACK_CONTROL_NEXT,
        ];
        profile.requirePlaybackNotification = false;
        return profile;
    }

    private function obj(id) {
        if (id == null) { return null; }
        return Media.getCachedContentObj(new Media.ContentRef(id, Media.CONTENT_TYPE_AUDIO));
    }

    // The boundary. The Brain reads the live activity and chooses.
    function next() {
        var pick = Brain.pickNext(mCurrent, mIds);
        if (pick == null) { return null; }
        mCurrent = pick;
        return obj(pick);
    }

    function previous() {
        // "Previous" = most recent from the Brain's memory, else stay.
        if (Brain.recentIds.size() >= 2) {
            mCurrent = Brain.recentIds[Brain.recentIds.size() - 2];
        }
        return obj(mCurrent);
    }

    function get() {
        if (mCurrent == null && mIds.size() > 0) {
            mCurrent = Brain.pickNext(null, mIds);
        }
        return obj(mCurrent);
    }

    function peekNext() {
        // A peek must not consume Brain state; show the neutral candidate.
        for (var i = 0; i < mIds.size(); i++) {
            if (mIds[i] != mCurrent) { return obj(mIds[i]); }
        }
        return null;
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
