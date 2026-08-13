// AWDJ visual language — members-club dark, editorial serif, one hot pulse.
// The room is nearly black; the music is the only thing wearing color.
import SwiftUI

enum Theme {
  // Surfaces — warm paper, never clinical white (pure white glares).
  static let bg = Color(red: 0.984, green: 0.98, blue: 0.973)           // #FBFAF8
  static let card = Color(red: 0.955, green: 0.949, blue: 0.937)        // #F4F2EF
  static let stroke = Color.black.opacity(0.1)

  // Ink
  static let ink = Color(red: 0.08, green: 0.08, blue: 0.09)
  static let inkDim = Color.black.opacity(0.55)
  static let inkFaint = Color.black.opacity(0.33)

  // One color: blue. White room, ink text, blue action (Ethan: "israel
  // colors so just white and blue").
  static let accent = Color(red: 0.0, green: 0.22, blue: 0.72)          // #0038B8
  // Kept names so call sites read the same; both resolve to the blue.
  static let pulse = LinearGradient(colors: [accent, accent], startPoint: .leading, endPoint: .trailing)
  static let pulseSolid = accent
}

/// Display text: plain system type, maximum legibility. (The serif
/// experiment lost — Ethan's final call: simple, easy to read, uncrowded.)
extension View {
  func displaySerif(_ size: CGFloat, weight: Font.Weight = .semibold) -> some View {
    font(.system(size: size, weight: weight))
  }
}

/// A single hairline — the only divider this design allows. Content is
/// structured by whitespace and type scale, never by boxes.
struct Hairline: View {
  var body: some View {
    Rectangle().fill(Theme.stroke).frame(height: 1)
  }
}

/// The one loud button in the room: solid blue, calm, no glow.
struct PulseButtonStyle: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .font(.system(size: 17, weight: .semibold))
      .foregroundColor(.white)
      .padding(.vertical, 16)
      .frame(maxWidth: .infinity)
      .background(Theme.accent)
      .clipShape(Capsule())
      .opacity(configuration.isPressed ? 0.85 : 1)
  }
}

/// Quiet secondary action: the tailored outlined pill — unmistakably a
/// button (Ethan's rule: all buttons obvious), never a filled box.
struct QuietButtonStyle: ButtonStyle {
  var compact = false
  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .font(.system(size: 15, weight: .medium))
      .foregroundColor(Theme.accent)
      .padding(.vertical, 12)
      .frame(maxWidth: compact ? nil : .infinity)
      .padding(.horizontal, compact ? 20 : 0)
      .overlay(Capsule().stroke(Theme.accent.opacity(0.45), lineWidth: 1))
      .contentShape(Capsule())
      .opacity(configuration.isPressed ? 0.5 : 1)
  }
}
