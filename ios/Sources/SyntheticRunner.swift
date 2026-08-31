// Synthetic runner — Swift port of syntheticSamples from src/replay/simulate.ts.
// Generates the 1Hz sample stream of a runner executing the plan: easy pace on
// easy-family steps, hard pace on hard steps, fatigue drift, deterministic
// wobble. Powers the in-app "Simulate run" demo — full LIVE mode with no watch.
import Foundation

struct RunScenario {
  var easyPaceSecPerKm: Double = 390
  var hardPaceSecPerKm: Double = 285
  var fatiguePct: Double = 5
  var noisePct: Double = 4
}

func nominalDurationMs(plan: [WorkoutStep], scenario o: RunScenario) -> Double {
  plan.reduce(0) { ms, s in
    if let seconds = s.seconds { return ms + seconds * 1000 }
    if let meters = s.meters {
      return ms + (meters / 1000) * (s.kind == "hard" ? o.hardPaceSecPerKm : o.easyPaceSecPerKm) * 1000
    }
    return ms
  }
}

func syntheticSamples(plan: [WorkoutStep], scenario o: RunScenario) -> [LiveSample] {
  var out: [LiveSample] = []
  let nominal = max(1, nominalDurationMs(plan: plan, scenario: o))
  let maxMs: Double = 3 * 3_600_000 // runaway backstop
  var t: Double = 0
  var d: Double = 0
  var stepIdx = 0
  var stepStartT: Double = 0
  var stepStartD: Double = 0

  while stepIdx < plan.count && t < maxMs {
    let step = plan[stepIdx]
    let basePace = step.kind == "hard" ? o.hardPaceSecPerKm : o.easyPaceSecPerKm
    let fatigue = 1 + (o.fatiguePct / 100) * min(1.5, t / nominal)
    let ts = t / 1000
    let wobble = sin(2 * .pi * ts / 45) * 0.6 + sin(2 * .pi * ts / 13) * 0.4
    let pace = basePace * fatigue * (1 + (o.noisePct / 100) * wobble)
    t += 1000
    d += 1000 / pace // meters covered this second
    // Stream the plan the way a watch does (wkStepSeq boundary counter +
    // current/next step shape) — the simulated runner exercises the engine's
    // FOLLOW MODE, the same path a real structured run drives. Before this,
    // the stand-in plan shaped only the runner's pace: the engine saw an
    // empty plan and cruised the whole workout (8/31: "0 cues landed").
    out.append(LiveSample(
      tMs: t, distanceM: (d * 10).rounded() / 10,
      wkStepSeq: Double(stepIdx),
      wkKind: step.kind,
      wkDurationType: step.seconds != nil ? 0 : (step.meters != nil ? 1 : nil),
      wkDurationValue: step.seconds ?? step.meters,
      wkNextKind: stepIdx + 1 < plan.count ? plan[stepIdx + 1].kind : nil
    ))
    let done: Bool
    if let seconds = step.seconds {
      done = t - stepStartT >= seconds * 1000
    } else if let meters = step.meters {
      done = d - stepStartD >= meters
    } else {
      done = true
    }
    if done {
      stepIdx += 1
      stepStartT = t
      stepStartD = d
    }
  }

  // Short easy-pace tail past the plan end so the final transition is audible.
  for _ in 0..<20 {
    t += 1000
    d += 1000 / o.easyPaceSecPerKm
    out.append(LiveSample(tMs: t, distanceM: (d * 10).rounded() / 10))
  }
  return out
}
