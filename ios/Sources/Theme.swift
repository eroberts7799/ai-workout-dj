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

  // The pulse — the icon's gradient, spent sparingly.
  static let pulse = LinearGradient(
    colors: [
      Color(red: 1.0, green: 0.42, blue: 0.16),   // hot orange
      Color(red: 0.94, green: 0.20, blue: 0.37),  // magenta red
      Color(red: 0.55, green: 0.36, blue: 0.96),  // violet
    ],
    startPoint: .leading, endPoint: .trailing
  )
  static let pulseSolid = Color(red: 0.94, green: 0.20, blue: 0.37)
}

/// Editorial serif for display text — DM Serif Display (OFL-licensed
/// high-contrast Didone; the fashion-editorial genus, not Apple's default).
extension View {
  func displaySerif(_ size: CGFloat, weight: Font.Weight = .medium) -> some View {
    font(.custom("DM Serif Display", size: size))
  }
}

/// A single hairline — the only divider this design allows. Content is
/// structured by whitespace and type scale, never by boxes.
struct Hairline: View {
  var body: some View {
    Rectangle().fill(Theme.stroke).frame(height: 1)
  }
}

/// The one loud button in the room.
struct PulseButtonStyle: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .font(.system(size: 16, weight: .semibold))
      .foregroundColor(.white)
      .padding(.vertical, 14)
      .frame(maxWidth: .infinity)
      .background(Theme.pulse)
      .clipShape(Capsule())
      .opacity(configuration.isPressed ? 0.85 : 1)
      .shadow(color: Theme.pulseSolid.opacity(0.35), radius: 14, y: 4)
  }
}

/// Quiet secondary action: bare text, small caps energy, no chrome.
struct QuietButtonStyle: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .font(.system(size: 14, weight: .medium))
      .foregroundColor(Theme.inkDim)
      .padding(.vertical, 10)
      .opacity(configuration.isPressed ? 0.5 : 1)
  }
}
