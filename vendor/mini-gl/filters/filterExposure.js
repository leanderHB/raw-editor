import { Shader } from '../minigl.js'

// Added by image_editor_simple project (2026-09-04).
//
// mini-gl's built-in filterAdjustments bakes exposure into the same 4x4 color-matrix
// pass as saturation/temperature/etc, which ends with a hard clamp(0,1) — so pushing
// exposure clips highlights to flat 1.0 *before* filterHighlightsShadows ever runs,
// making blown-out highlights structurally unrecoverable regardless of what runs
// after. This is a separate pass, applied first, with a smooth highlight roll-off
// instead of a hard clamp — the standard "soft clip" / filmic shoulder technique,
// so highlights compress gracefully instead of slamming into white.
const _fragment = `#version 300 es
      precision highp float;
      in vec2 texCoord;
      uniform sampler2D _texture;
      uniform float exposureMul; // 2^stops
      uniform float knee;        // value above which highlights start compressing (0..1)
      out vec4 outColor;

      vec3 softClipHighlights(vec3 c, float k) {
        vec3 excess = max(c - k, 0.0);
        vec3 belowKnee = min(c, vec3(k));
        return belowKnee + (1.0 - k) * tanh(excess / max(1.0 - k, 0.0001));
      }

      void main() {
        vec4 color = texture(_texture, texCoord);
        vec3 exposed = color.rgb * exposureMul;
        outColor = vec4(softClipHighlights(exposed, knee), color.a);
      }
    `

export function filterExposure(mini, stops, knee = 0.8) {
  if (!stops) return
  mini._.$exposure = mini._.$exposure || new Shader(mini.gl, null, _fragment)
  mini.runFilter(mini._.$exposure, { exposureMul: Math.pow(2, stops), knee })
}
