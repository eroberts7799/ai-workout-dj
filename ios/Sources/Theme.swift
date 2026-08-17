// Field Manual design tokens — the iOS translation of DESIGN.md.
// Paper, ink, and olive drab; grit from weight and stamps, not darkness.
// System stand-ins for the web faces: compressed-black ≈ Big Shoulders,
// SF Mono ≈ JetBrains Mono, condensed-semibold ≈ Barlow Condensed.
import SwiftUI

enum Theme {
  static let paper = Color(red: 0.980, green: 0.976, blue: 0.961) // #FAF9F5
  static let ink = Color(red: 0.090, green: 0.090, blue: 0.067) // #171711
  static let seam = Color(red: 0.867, green: 0.859, blue: 0.812) // #DDDBCF
  static let faded = Color(red: 0.486, green: 0.486, blue: 0.427) // #7C7C6D
  static let olive = Color(red: 0.294, green: 0.325, blue: 0.125) // #4B5320
  static let oliveWash = Color(red: 0.933, green: 0.937, blue: 0.890) // #EEEFE3
  static let fail = Color(red: 0.702, green: 0.251, blue: 0.165) // #B3402A
}

extension Text {
  /// Display voice — headlines, countdowns, the one loud thing per screen.
  func fieldDisplay(_ size: CGFloat = 34) -> Text {
    font(.system(size: size, weight: .black)).fontWidth(.compressed)
  }

  /// Subhead voice — track names, section labels.
  func fieldSubhead(_ size: CGFloat = 15) -> Text {
    font(.system(size: size, weight: .semibold)).fontWidth(.condensed)
  }

  /// Data voice — clocks, counts, telemetry. Tabular by nature of SF Mono.
  func fieldMono(_ size: CGFloat = 13, weight: Font.Weight = .regular) -> Text {
    font(.system(size: size, weight: weight, design: .monospaced))
  }

  /// Micro-label voice — stamped uppercase tags.
  func fieldLabel() -> Text {
    font(.system(size: 11, weight: .semibold, design: .monospaced)).kerning(1.6)
  }
}

/// The one filled control per screen — olive, square, display-face.
struct ArmButtonStyle: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .font(.system(size: 17, weight: .black))
      .fontWidth(.compressed)
      .textCase(.uppercase)
      .foregroundColor(Theme.paper)
      .padding(.horizontal, 28)
      .padding(.vertical, 11)
      .background(Theme.olive)
      .opacity(configuration.isPressed ? 0.85 : 1)
  }
}

/// Secondary actions — condensed uppercase over an ink underline. No chrome.
struct FieldButtonStyle: ButtonStyle {
  var color: Color = Theme.ink
  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .font(.system(size: 14, weight: .semibold))
      .fontWidth(.condensed)
      .textCase(.uppercase)
      .kerning(1.0)
      .foregroundColor(configuration.isPressed ? Theme.olive : color)
      .padding(.vertical, 4)
      .overlay(alignment: .bottom) {
        Rectangle().fill(configuration.isPressed ? Theme.olive : color).frame(height: 2)
      }
  }
}

/// Section break — the 3pt ink bar from the web lab's ruled sections.
struct SectionBar: View {
  var body: some View {
    Rectangle().fill(Theme.ink).frame(height: 3)
  }
}
