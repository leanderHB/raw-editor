import { Shader } from '../minigl.js'

// Added by image_editor_simple project (2026-09-04).
//
// mini-gl's pipeline works in linear light throughout (see minigl.js header comment).
// That's correct for exposure/highlight-recovery math, but tone curves like a base/
// camera-profile curve or a parametric contrast curve are conventionally designed
// against *display-referred* (gamma/sRGB-encoded) values — their control points
// assume e.g. 0.25/0.75 land near the actual quarter/three-quarter-tone appearance,
// which is only true in gamma space (linear 0.25 and gamma 0.25 are very different
// brightnesses). Applying such a curve directly to linear data distorts it —
// disproportionately hammering shadows and blowing out highlights. These two filters
// let a curve be bracketed correctly: filterToGamma() -> filterCurves(...) -> filterToLinear().
const toGammaFragment = `#version 300 es
      precision highp float;
      in vec2 texCoord;
      uniform sampler2D _texture;
      out vec4 outColor;
      vec4 fromLinear(vec4 linearRGB) {
          bvec3 cutoff = lessThan(linearRGB.rgb, vec3(0.0031308));
          vec3 higher = vec3(1.055)*pow(linearRGB.rgb, vec3(1.0/2.4)) - vec3(0.055);
          vec3 lower = linearRGB.rgb * vec3(12.92);
          return vec4(mix(higher, lower, cutoff), linearRGB.a);
      }
      void main() { outColor = fromLinear(texture(_texture, texCoord)); }
    `

const toLinearFragment = `#version 300 es
      precision highp float;
      in vec2 texCoord;
      uniform sampler2D _texture;
      out vec4 outColor;
      vec4 toLinear(vec4 sRGB) {
          bvec3 cutoff = lessThan(sRGB.rgb, vec3(0.04045));
          vec3 higher = pow((sRGB.rgb + vec3(0.055))/vec3(1.055), vec3(2.4));
          vec3 lower = sRGB.rgb/vec3(12.92);
          return vec4(mix(higher, lower, cutoff), sRGB.a);
      }
      void main() { outColor = toLinear(texture(_texture, texCoord)); }
    `

export function filterToGamma(mini) {
  mini._.$toGamma = mini._.$toGamma || new Shader(mini.gl, null, toGammaFragment)
  mini.runFilter(mini._.$toGamma, null)
}

export function filterToLinear(mini) {
  mini._.$toLinear = mini._.$toLinear || new Shader(mini.gl, null, toLinearFragment)
  mini.runFilter(mini._.$toLinear, null)
}
