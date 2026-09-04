import { Shader } from '../minigl.js'

// Added by image_editor_simple project (2026-09-05).
//
// Lightroom's Whites/Blacks are distinct from Highlights/Shadows: Highlights/
// Shadows do a regional tone-compression recovery (see filterHighlightsShadows),
// while Whites/Blacks set the actual clip points — a plain linear levels remap
// (output = (input - blackPoint) / (whitePoint - blackPoint)). Positive Whites
// lowers the input threshold that clips to pure white (brighter/more clipping);
// positive Blacks raises the shadow floor (lifted/less-crushed blacks).
const _fragment = `#version 300 es
      precision highp float;
      in vec2 texCoord;
      uniform sampler2D _texture;
      uniform float blackPoint;
      uniform float whitePoint;
      out vec4 outColor;

      void main() {
        vec4 color = texture(_texture, texCoord);
        vec3 result = (color.rgb - blackPoint) / max(whitePoint - blackPoint, 0.0001);
        outColor = vec4(clamp(result, 0.0, 1.0), color.a);
      }
    `

export function filterLevels(mini, blacks, whites) {
  if (!blacks && !whites) return
  const blackPoint = -blacks * 0.25
  const whitePoint = 1 - whites * 0.25
  mini._.$levels = mini._.$levels || new Shader(mini.gl, null, _fragment)
  mini.runFilter(mini._.$levels, { blackPoint, whitePoint })
}
