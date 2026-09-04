import { Shader } from '../minigl.js'

// Added by image_editor_simple project (2026-09-05).
//
// Chromatic-aberration cleanup, done the way most editors' quick "Defringe"
// controls work (Lightroom's Defringe sliders, not the geometric "Remove
// Chromatic Aberration" checkbox, which needs per-channel radial registration
// analysis against the whole frame — a much bigger undertaking). This instead:
// 1. Detects high-contrast edges (simple 4-neighbor luminance difference).
// 2. Detects purple/magenta fringing (R and B both elevated over G) and green
//    fringing (G elevated over both R and B) — the two classic CA fringe colors.
// 3. Only where both are true, desaturates that pixel toward its own luminance
//    — removing the color cast without touching contrast or legitimate
//    saturated colors elsewhere in the frame.
const _fragment = `#version 300 es
      precision highp float;
      in vec2 texCoord;
      uniform sampler2D _texture;
      uniform vec2 uResolution;
      uniform float strength;
      out vec4 outColor;

      float lum(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

      void main() {
        vec3 color = texture(_texture, texCoord).rgb;
        if (strength <= 0.0) { outColor = vec4(color, 1.0); return; }

        vec2 px = 1.0 / uResolution;
        float lC = lum(color);
        float lL = lum(texture(_texture, texCoord - vec2(px.x, 0.0)).rgb);
        float lR = lum(texture(_texture, texCoord + vec2(px.x, 0.0)).rgb);
        float lU = lum(texture(_texture, texCoord - vec2(0.0, px.y)).rgb);
        float lD = lum(texture(_texture, texCoord + vec2(0.0, px.y)).rgb);
        float edge = abs(lC - lL) + abs(lC - lR) + abs(lC - lU) + abs(lC - lD);

        float purpleness = max(0.0, min(color.r, color.b) - color.g);
        float greenness = max(0.0, color.g - max(color.r, color.b));
        float fringiness = max(purpleness, greenness);

        float amount = fringiness * smoothstep(0.05, 0.3, edge) * strength * 4.0;
        vec3 desaturated = vec3(lC);
        outColor = vec4(mix(color, desaturated, clamp(amount, 0.0, 1.0)), 1.0);
      }
    `

export function filterDefringe(mini, strength) {
  if (!strength) return
  const { gl } = mini
  mini._.$defringe = mini._.$defringe || new Shader(gl, null, _fragment)
  mini.runFilter(mini._.$defringe, { strength, uResolution: [gl.canvas.width, gl.canvas.height] })
}
