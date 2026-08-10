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
import Toybox.WatchUi;

class AwdjField extends WatchUi.SimpleDataField {
  private var _lastPostMs as Number = 0;
  private var _pendingEvent as String? = null;

  function initialize() {
    SimpleDataField.initialize();
    label = "AI DJ";
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

  function compute(info as Activity.Info) as Numeric or Duration or String or Null {
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
      _pendingEvent = null;
      return;
    }
    var body = {
      "event" => _pendingEvent,
      "hr" => info.currentHeartRate,
      "timerMs" => info.timerTime,
      "altitude" => info.altitude,
      "speed" => info.currentSpeed,
    };
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
