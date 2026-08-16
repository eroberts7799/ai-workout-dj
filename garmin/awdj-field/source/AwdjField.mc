// AI Workout DJ — Connect IQ data field.
// Add this field to any activity screen. It shows your HR like a normal field,
// and streams {event, hr, timerMs, lat, lon, altitude} to the conductor once
// per second via the phone's Garmin Connect app. Timer start/pause/resume/stop
// are sent as events — the conductor auto-starts backdated to your button press.
import Toybox.Activity;
import Toybox.Application.Properties;
import Toybox.Communications;
import Toybox.Lang;
import Toybox.System;
import Toybox.Time;
import Toybox.WatchUi;

class AwdjField extends WatchUi.SimpleDataField {
  private var _lastPostMs as Number = 0;
  private var _pendingEvent as String? = null;
  private var _stepSeq as Number = 0;
  private var _lastStepSig as String = "";

  function initialize() {
    SimpleDataField.initialize();
    label = "AI DJ";
  }

  // The watch already knows the Runna plan: structured-workout steps are
  // exposed live. Map Garmin intensity to the conductor's step vocabulary.
  private function kindOf(intensity as Number?) as String {
    if (intensity == Activity.WORKOUT_INTENSITY_ACTIVE) { return "hard"; }
    if (intensity == Activity.WORKOUT_INTENSITY_INTERVAL) { return "hard"; }
    if (intensity == Activity.WORKOUT_INTENSITY_WARMUP) { return "warmup"; }
    if (intensity == Activity.WORKOUT_INTENSITY_COOLDOWN) { return "cooldown"; }
    if (intensity == Activity.WORKOUT_INTENSITY_RECOVERY) { return "easy"; }
    if (intensity == Activity.WORKOUT_INTENSITY_REST) { return "rest"; }
    return "easy";
  }

  private function stepDict(step as Activity.WorkoutStepInfo?) as Dictionary? {
    if (step == null || step.step == null) { return null; }
    var ws = step.step;
    if (!(ws instanceof Activity.WorkoutStep)) { return null; } // interval blocks etc.
    return {
      "kind" => kindOf(step.intensity), // intensity lives on the info wrapper
      "durationType" => ws.durationType,
      "durationValue" => ws.durationValue,
      "name" => step.name,
      // Target band (pace/HR) — distinguishes same-shape adjacent steps and
      // feeds the conductor's ETA priors later.
      "targetLow" => ws.targetValueLow,
      "targetHigh" => ws.targetValueHigh,
    };
  }

  function onTimerStart() as Void {
    _pendingEvent = "timerStart";
  }

  function onTimerPause() as Void {
    _pendingEvent = "timerPause";
  }

  function onTimerResume() as Void {
    _pendingEvent = "timerResume";
  }

  function onTimerStop() as Void {
    _pendingEvent = "timerStop";
  }

  function compute(info as Activity.Info) as Numeric or Time.Duration or String or Null {
    var now = System.getTimer();
    // Post immediately on events; otherwise 1Hz.
    if (_pendingEvent != null || now - _lastPostMs >= 1000) {
      postSample(info);
      _lastPostMs = now;
    }
    return info.currentHeartRate != null ? info.currentHeartRate : 0;
  }

  private function postSample(info as Activity.Info) as Void {
    var url = Properties.getValue("endpoint") as String?;
    if (url == null || url.equals("")) {
      // Permanent public relay: HTTPS (Garmin requires it off-LAN), works
      // from any network including LTE. Settings can still override.
      url = "https://awdj-relay.vercel.app/api/garmin?k=awdj-7g2k9x";
    }
    var body = {
      "via" => "relay",
      "event" => _pendingEvent,
      "hr" => info.currentHeartRate,
      "timerMs" => info.timerTime,
      "altitude" => info.altitude,
      "speed" => info.currentSpeed,
      "distance" => info.elapsedDistance,
      "cadence" => info.currentCadence,
    };
    // Structured-workout awareness (Runna, Garmin Coach…): current + next
    // step, plus a sequence number that bumps on every step change so the
    // conductor can timestamp step starts from its own clock.
    var cur = stepDict(Activity.getCurrentWorkoutStep());
    if (cur != null) {
      // Signature must separate ADJACENT steps that share a shape: Rolling
      // 800s = 8 back-to-back distance-804m actives differing only by target
      // pace. Name + target band carry that difference. (Truly identical
      // adjacent steps stay undetectable here — the conductor's odometer
      // fallback covers those.)
      var sig = (cur["kind"] as String) + "|" + cur["durationType"] + "|" + cur["durationValue"]
        + "|" + cur["targetLow"] + "|" + cur["targetHigh"] + "|" + cur["name"];
      if (!sig.equals(_lastStepSig)) {
        _lastStepSig = sig;
        _stepSeq += 1;
      }
      body["wkStep"] = cur;
      body["wkStepSeq"] = _stepSeq;
      var nxt = stepDict(Activity.getNextWorkoutStep());
      if (nxt != null) {
        body["wkNext"] = nxt;
      }
    }
    if (info.currentLocation != null) {
      var deg = info.currentLocation.toDegrees();
      body["lat"] = deg[0];
      body["lon"] = deg[1];
    }
    _pendingEvent = null;
    Communications.makeWebRequest(
      url,
      body,
      {
        :method => Communications.HTTP_REQUEST_METHOD_POST,
        :headers => { "Content-Type" => Communications.REQUEST_CONTENT_TYPE_JSON },
      },
      method(:onResponse)
    );
  }

  function onResponse(code as Number, data as Dictionary or String or Null) as Void {
    // Fire-and-forget: mid-run, a failed post must never disturb the athlete.
  }
}
