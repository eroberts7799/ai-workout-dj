// ContentDelegate + ContentIterator — the sample's pull model, stripped to
// sequential play, with the spike's logging in every callback. If the AWDJ
// lines in the device log show live timer/hr/dist inside next()/onSong()
// during a native run, boundary-mode DJing on the watch is buildable.

using Toybox.Media;

class SpikeContentDelegate extends Media.ContentDelegate {

    private var mIterator;
    private var mEvents = ["Start", "SkipNext", "SkipPrev", "Notify", "Complete", "Stop", "Pause", "Resume", "SkipFwd", "SkipBack"];

    function initialize() {
        ContentDelegate.initialize();
        mIterator = new SpikeContentIterator();
    }

    function getContentIterator() {
        SpikeLog.log("getContentIterator", "-");
        return mIterator;
    }

    function resetContentIterator() {
        mIterator = new SpikeContentIterator();
        return mIterator;
    }

    function onSong(refId, songEvent, playbackPosition) {
        var name = songEvent >= 0 && songEvent < mEvents.size() ? mEvents[songEvent] : "evt" + songEvent;
        SpikeLog.log("onSong", name + " pos=" + playbackPosition);
    }
}

class SpikeContentIterator extends Media.ContentIterator {

    private var mIdx;
    private var mRefs;

    function initialize() {
        ContentIterator.initialize();
        mIdx = 0;
        mRefs = [];
        var iter = Media.getContentRefIter({:contentType => Media.CONTENT_TYPE_AUDIO});
        if (iter != null) {
            var ref = iter.next();
            while (ref != null) {
                mRefs.add(ref.getId());
                ref = iter.next();
            }
        }
        SpikeLog.log("iterator.init", "songs=" + mRefs.size());
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

    private function at(idx) {
        if (idx < 0 || idx >= mRefs.size()) {
            return null;
        }
        return Media.getCachedContentObj(new Media.ContentRef(mRefs[idx], Media.CONTENT_TYPE_AUDIO));
    }

    // THE moment that matters: the player asks what plays next. If the
    // activity line here is live, the engine can choose by body state.
    function next() {
        mIdx = (mIdx + 1) % (mRefs.size() > 0 ? mRefs.size() : 1);
        SpikeLog.log("next", "idx=" + mIdx);
        return at(mIdx);
    }

    function previous() {
        mIdx = mIdx > 0 ? mIdx - 1 : 0;
        SpikeLog.log("previous", "idx=" + mIdx);
        return at(mIdx);
    }

    function get() {
        SpikeLog.log("get", "idx=" + mIdx);
        return at(mIdx);
    }

    function peekNext() {
        return at((mIdx + 1) % (mRefs.size() > 0 ? mRefs.size() : 1));
    }

    function peekPrevious() {
        return at(mIdx - 1);
    }

    function shuffling() {
        return false;
    }

    function canSkip() {
        return true;
    }
}
