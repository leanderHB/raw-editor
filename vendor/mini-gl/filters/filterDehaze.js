import { Shader } from '../minigl.js'

// Added by image_editor_simple project (2026-09-05).
//
// Honest caveat: real Dehaze (Lightroom/ACR) estimates a per-pixel transmission
// map via a "dark channel prior" analyzed across the whole frame — an adaptive,
// spatially-varying correction. That's a much bigger undertaking (needs a local
// min-filter pass over a neighborhood plus an edge-aware refinement pass to avoid
// haloing). This instead uses the classic single-scattering atmospheric model
// (Koschmieder): observed = scene*t + airlight*(1-t), solved for scene.
//
// First version scaled the transmission divisor directly with the slider, which
// blows up for any pixel not already close to the near-white airlight estimate —
// on a normally dark/contrasty (non-hazy) test photo that crushed nearly the
// whole frame to black. Fixed by computing the dehazed result at one FIXED,
// moderate transmission assumption, then blending toward it by `amount` — bounded
// regardless of slider position, since blending can't run away the way scaling
// the division did.
const _fragment = `#version 300 es
      precision highp float;
      in vec2 texCoord;
      uniform sampler2D _texture;
      uniform float amount; // -1..1: positive removes haze, negative adds it
      out vec4 outColor;

      void main() {
        vec4 color = texture(_texture, texCoord);
        vec3 airlight = vec3(0.85, 0.85, 0.87); // typical haze color: light, slightly cool gray

        vec3 result;
        if (amount >= 0.0) {
          const float t = 0.55; // fixed moderate transmission for the "full effect" target
          vec3 dehazed = (color.rgb - airlight) / t + airlight;
          result = mix(color.rgb, dehazed, amount);
        } else {
          result = mix(color.rgb, airlight, -amount * 0.5);
        }
        outColor = vec4(clamp(result, 0.0, 1.0), color.a);
      }
    `

export function filterDehaze(mini, amount) {
  if (!amount) return
  mini._.$dehaze = mini._.$dehaze || new Shader(mini.gl, null, _fragment)
  mini.runFilter(mini._.$dehaze, { amount })
}
