/*
*  HEAVILY MODIFIED VERSION of glfx.js by Evan Wallace
*  https://evanw.github.io/glfx.js/
*
*  PATCHED by image_editor_simple project (2026-09-04):
*  - all working textures (image + ping-pong buffers) now use RGBA32F instead
*    of 8-bit SRGB8_ALPHA8, so the edit pipeline retains full float precision
*    from a 16-bit raw decode instead of quantizing to 8-bit immediately.
*  - added Texture.loadFloatData() to upload a Float32Array (e.g. from
*    libraw's 16-bit output) directly, bypassing the <img>/canvas roundtrip
*    that would otherwise clamp everything back to 8-bit.
*  - RGBA32F has no automatic sRGB<->linear hardware conversion (unlike
*    SRGB8_ALPHA8), so loadImage() now runs an explicit toLinear() pass when
*    loading float source data, and captureImage()/readPixels()/crop() do the
*    linear->sRGB encode in JS after a float readback instead of relying on
*    the old implicit 8-bit readback conversion.
*  Original: https://github.com/xdadda/mini-gl (MIT license, see LICENSE)
*/

import * as Filters from './minigl_filters.js'
export {Spline} from './filters/cubicspline.js'

const usesrgb=true //to guarantee gamma correct workflow, SRGB in input - processing is linear - SRGB in output

// mirrors the GLSL fromLinear() function used in shaders — applied here in JS when
// reading pixels back out of the float pipeline (see linearFloatToSRGB8 below)
function linearToSrgb(v){ return v <= 0.0031308 ? v*12.92 : 1.055*Math.pow(v,1/2.4)-0.055 }

// converts a linear-light Float32Array (RGBA, 0..1) readback into 8-bit sRGB-encoded
// pixel data ready for ImageData/canvas — replaces the old implicit conversion that
// used to happen automatically via the SRGB8_ALPHA8 texture format on readback.
function linearFloatToSRGB8(floatData){
  const out = new Uint8ClampedArray(floatData.length)
  for (let i = 0; i < floatData.length; i += 4) {
    out[i]   = Math.round(linearToSrgb(floatData[i])   * 255)
    out[i+1] = Math.round(linearToSrgb(floatData[i+1]) * 255)
    out[i+2] = Math.round(linearToSrgb(floatData[i+2]) * 255)
    out[i+3] = Math.round(floatData[i+3] * 255)
  }
  return out
}

export function minigl(canvas,img,colorspace) {
  let gl = canvas.getContext("webgl2",{ antialias:false, premultipliedAlpha: true, })
  if (!gl) return console.error("webgl2 not supported!")
  // needed to render into / linear-sample RGBA32F textures (the working pipeline's format)
  if (!gl.getExtension('EXT_color_buffer_float')) console.error('EXT_color_buffer_float not supported — float-precision editing pipeline will not work')
  gl.getExtension('OES_texture_float_linear') // optional: smooth (not nearest) sampling of float textures
  if(colorspace==="display-p3") {
    gl.drawingBufferColorSpace = "display-p3";
    gl.unpackColorSpace = "display-p3";
  } else {
    gl.drawingBufferColorSpace = "srgb";
    gl.unpackColorSpace = "srgb";
  }

  const _minigl= {
    width:0,
    height:0,
    gl,
    img,
    destroy,
    loadImage,
    paintCanvas,
    crop,
    resetCrop,
    resize,
    resetResize,
    captureImage,
    readPixels,
    runFilter,
    setupFiltersTextures,
    _:{} //for filters' storage
   }

  //update canvas size to image for full resolution. Use style to change visible sizes
  gl.canvas.width=_minigl.width=img.naturalWidth
  gl.canvas.height=_minigl.height=img.naturalHeight
 
  //create IMAGE TEXTURE && load image
  const imageTexture = new Texture(gl)
  if (img.floatData) imageTexture.loadFloatData(img.floatData, img.naturalWidth, img.naturalHeight)
  else imageTexture.loadImage(img)
  //imageTexture.label='imageTXT'
  //create default SHADER
  const defaultShader = new Shader(gl)
  const flippedShader = new Shader(gl,null,flippedFragmentSource)
  // only used for the initial load of raw float source data (sRGB-encoded, not yet
  // linear) — everything else in the pipeline assumes linear-light values already,
  // exactly as the old SRGB8_ALPHA8 format used to guarantee via automatic hardware
  // decode-on-sample. RGBA32F has no such automatic conversion, so this makes it explicit.
  const toLinearShader = new Shader(gl,null,toLinearFragmentSource)
  
  //create two effects' blank textures to handle [image-->shaderA-->txt1-->shaderB-->txt2-->canvas]
  //note: setupFiltersTextures needs to be re-run if canvas width/height change (eg when changing aspect ratio)
  let textures, count=0;
  function setupFiltersTextures(){
    if(textures?.length) textures.forEach(e=>e.destroy())
    textures=[]
    for (var ii = 0; ii < 2; ++ii) {
      // make the blank texture the same size as the canvas
      const texture = new Texture(gl,gl.canvas.width, gl.canvas.height);
      textures.push(texture);
    }
  }
  setupFiltersTextures()

  function destroy(){
    if(textures?.length) textures.forEach(e=>e.destroy())
    if(croppedTexture) croppedTexture.destroy()
    imageTexture.destroy()
    delete _minigl.img_cropped
  }

  let current_texture
  function runFilter(shader, uniforms){
    if(uniforms) shader.uniforms(uniforms)
    //console.log('runFilter',current_texture.label)
    if(current_texture) current_texture.use()
    textures[count%2].drawTo()
    shader.drawRect()
    current_texture=textures[count%2]
    count++
  }

  function loadImage(){
    if(croppedTexture) current_texture= croppedTexture
    else current_texture=imageTexture
    // the base image texture holds raw sRGB-encoded values when loaded via the float
    // path (RGBA32F has no automatic sRGB decode like SRGB8_ALPHA8 did), so linearize
    // explicitly here so every filter downstream still receives linear light.
    // croppedTexture is always loaded via the old 8-bit SRGB8_ALPHA8 path (see crop()),
    // which still auto-decodes on sample, so it never needs this extra step.
    const needsLinearize = !croppedTexture && img.floatData
    runFilter(needsLinearize ? toLinearShader : defaultShader, null)
  }

  function paintCanvas(){
    if(current_texture) current_texture.use()
    gl.bindFramebuffer(gl.FRAMEBUFFER, null) //draw to canvas
    flippedShader.drawRect()
  }


  let resized = {width:0,height:0}
  function resize(width,height){
    gl.canvas.width=_minigl.width=resized.width = width
    gl.canvas.height=_minigl.height=resized.height = height
    setupFiltersTextures()
  }
  function resetResize(){
    if(!resized.width) return
    resized.width=resized.height=0
    gl.canvas.width=_minigl.width= cropsize.width || img.naturalWidth
    gl.canvas.height=_minigl.height= cropsize.height || img.naturalHeight
    setupFiltersTextures()
  }

  
  let croppedTexture
  let cropsize = {width:0,height:0}
  function crop({left, top, width, height}){
      const length = width * height * 4;
      const floatData = new Float32Array(length);

      //FIX FOR SAFARI & display-p3 bug (a direct GL->2D drawImage loses colorspace ... this is a workaround)
      runFilter(defaultShader,{})
      gl.readPixels(left,top,width,height,gl.RGBA,gl.FLOAT,floatData);
      const colorspace=gl.unpackColorSpace
      const imgdata_cropped = new ImageData(linearFloatToSRGB8(floatData), width, height, { colorSpace: colorspace})

      croppedTexture = new Texture(gl)
      croppedTexture.loadImage(imgdata_cropped)
      gl.canvas.width=_minigl.width=cropsize.width = width
      gl.canvas.height=_minigl.height=cropsize.height = height
      setupFiltersTextures()
      _minigl.img_cropped = imagedata_to_image(imgdata_cropped,colorspace)
  }
  
  function resetCrop(){
    if(!croppedTexture) return
    croppedTexture.destroy()
    croppedTexture=null
    cropsize.width=cropsize.height=0
    gl.canvas.width=_minigl.width= resized.width || img.naturalWidth
    gl.canvas.height=_minigl.height= resized.height || img.naturalHeight
    delete _minigl.img_cropped
    setupFiltersTextures()
  }

  //type: String - indicating the image format. The default type is image/png
  //quality: Number - between 0 and 1 indicating the image quality to be used with lossy compression
  //returns Image
  function captureImage(type, quality){
      runFilter(defaultShader,{})
      const {width,height}=gl.canvas
      const length = width * height * 4;
      const floatData = new Float32Array(length);
      gl.readPixels(0,0,width,height,gl.RGBA,gl.FLOAT,floatData);
      const colorspace=gl.unpackColorSpace
      const imgdata = new ImageData(linearFloatToSRGB8(floatData), width, height, { colorSpace: colorspace})
      return imagedata_to_image(imgdata, colorspace, type,quality)
  }

  // returns 8-bit sRGB-encoded pixel bytes (same as before the float patch); pass
  // {raw:true} to get the unconverted linear-light Float32Array straight off the GPU
  // (e.g. for further high-precision processing) instead.
  function readPixels(opts){
      runFilter(defaultShader,{})
      const {width,height}=gl.canvas
      const length = width * height * 4;
      const floatData = new Float32Array(length);
      gl.readPixels(0,0,width,height,gl.RGBA,gl.FLOAT,floatData);
      return opts?.raw ? floatData : linearFloatToSRGB8(floatData)
  }



  //load all filters
  function wrap(fn){
    return function(...args){fn(_minigl,...args)}
  }
  Object.keys(Filters).forEach(f=>_minigl[f]=wrap(Filters[f]))

  return _minigl
}

const flippedFragmentSource = usesrgb
      ?`#version 300 es
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

        void main() {
            vec4 color = texture(_texture, vec2(texCoord.x, 1.0 - texCoord.y));
            //outColor = color;
            outColor = fromLinear(color);
        }`
      :`#version 300 es
        precision highp float;
        in vec2 texCoord;
        uniform sampler2D _texture;
        out vec4 outColor;

        void main() {
            outColor = texture(_texture, vec2(texCoord.x, 1.0 - texCoord.y));
        }`

const toLinearFragmentSource = `#version 300 es
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

        void main() {
            outColor = toLinear(texture(_texture, texCoord));
        }`


export function Shader(gl,vertexSrc,fragmentSrc) {

      const defaultVertexSource = `#version 300 es
        in vec2 vertex;
        out vec2 texCoord;

        void main() {
          texCoord = vertex;
          gl_Position = vec4(vertex * 2.0 - 1.0, 0.0, 1.0);
        }
      `;

      const defaultFragmentSource = `#version 300 es
        precision highp float;

        in vec2 texCoord;
        uniform sampler2D _texture;
        out vec4 outColor;   

        void main() {
          outColor = texture(_texture, texCoord);
        }
      `;


    const program = gl.createProgram()
    let vertex
    gl.attachShader(program,compileSource(gl, gl.VERTEX_SHADER, vertexSrc||defaultVertexSource))
    gl.attachShader(program,compileSource(gl, gl.FRAGMENT_SHADER,fragmentSrc|| defaultFragmentSource))
    gl.linkProgram(program)
    

    function drawRect(refresh=true, left, top, right, bottom){
          //get the current viewport
          const viewport = gl.getParameter(gl.VIEWPORT);
          left = left !== undefined ? (left - viewport[0]) / viewport[2] : 0;
          top = top !== undefined ? (top - viewport[1]) / viewport[3] : 0;
          right = right !== undefined ? (right - viewport[0]) / viewport[2] : 1;
          bottom = bottom !== undefined ? (bottom - viewport[1]) / viewport[3] : 1;

      //prepare vertex
      gl.useProgram(program)
      gl.vertexBuffer = gl.vertexBuffer || gl.createBuffer()
      gl.bindBuffer(gl.ARRAY_BUFFER, gl.vertexBuffer)
      //1 unit wad
      gl.bufferData(
        gl.ARRAY_BUFFER,
        new Float32Array([ left, top, left, bottom, right, top, right, bottom ]),
        gl.STATIC_DRAW
      )
      if(!vertex) {
        vertex = gl.getAttribLocation(program, "vertex")
        gl.enableVertexAttribArray(vertex)
      }
      gl.vertexAttribPointer(vertex, 2, gl.FLOAT, false, 0, 0)

      //convert from clip space to pixel space
      //gl.viewport(0, 0, gl.canvas.width, gl.canvas.height)
      //clear canvas
      if(refresh){
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.GL_DEPTH_BUFFER_BIT);
      }
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    }
    
    function uniforms(uni={}){
      gl.useProgram(program);
      for (let name in uni) {
        const location = gl.getUniformLocation(program, name);
        if (location === null) continue; // will be null if the uniform isn't used in the shader
        let value = uni[name];
        if (Array.isArray(value)) {
          switch (value.length) {
            case 1: {
              if(Array.isArray(value[0])) value=value[0] //to load uniform float array[9]
              gl.uniform1fv(location, new Float32Array(value)); break;
            }
            case 2: gl.uniform2fv(location, new Float32Array(value)); break;
            case 3: gl.uniform3fv(location, new Float32Array(value)); break;
            case 4: gl.uniform4fv(location, new Float32Array(value)); break;
            case 9: gl.uniformMatrix3fv(location, false, new Float32Array(value)); break;
            case 16: gl.uniformMatrix4fv(location, false, new Float32Array(value)); break;
            default: throw 'dont\'t know how to load uniform "' + name + '" of length ' + value.length;
          }
        } 
        else if (value?.unit) { // {unit:1} ... it's a texture loaded in slot unit
          gl.uniform1i(location, value.unit);
        }
        else if (typeof value === 'number') {
          gl.uniform1f(location, value);
        } 
        else {
          throw 'attempted to set uniform "' + name + '" to invalid value ' + (value || 'undefined').toString();
        }       
      }
    }
    
    function compileSource(gl, type, source) {
      var shader = gl.createShader(type)
      gl.shaderSource(shader, source)
      gl.compileShader(shader)
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        throw "compile error: " + gl.getShaderInfoLog(shader)
      }
      return shader
    }


    return {drawRect, uniforms}
}

export function Texture(gl, width, height) {
    let _width=width, _height=height
    let txt = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, txt);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    //if size provided, create blank texture
    //RGBA32F (float) rather than 8-bit SRGB8_ALPHA8: these are the working ping-pong
    //buffers the whole filter chain renders through, so they need full precision to
    //avoid quantizing/banding a 16-bit raw decode back down to 8 bits mid-pipeline.
    if (width && height) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, width, height, 0, gl.RGBA, gl.FLOAT, null);

    function use(unit=0){
      if(!txt) return console.error('texture has been destroyed')
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, txt)
    }
    function destroy(){
      gl.deleteTexture(txt);
      txt=null
    }
    function drawTo(){
      if(!txt) return console.error('texture has been destroyed')
      // create/ reuse a framebuffer
      gl.framebuffer = gl.framebuffer || gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, gl.framebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, txt, 0);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
          throw new Error('incomplete framebuffer');
      }
      //sets the conversion from normalized device coordinates/ clip space to pixel space
      gl.viewport(0,0,_width,_height)
    }
    function loadImage(img, format){
      if(!txt) return console.error('texture has been destroyed')
      _width=img.naturalWidth
      _height=img.naturalHeight
      gl.bindTexture(gl.TEXTURE_2D, txt)

      let internalFormat = format || (usesrgb ? gl.SRGB8_ALPHA8 : gl.RGBA)
      gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, gl.RGBA, gl.UNSIGNED_BYTE, img)
      //gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img)
      //gl.texImage2D(gl.TEXTURE_2D, 0, gl.SRGB8_ALPHA8, gl.RGBA, gl.UNSIGNED_BYTE, img)
    }
    function initFromBytes(width, height, data, format) {
      _width=width
      _height=height
      gl.bindTexture(gl.TEXTURE_2D, txt);
      let internalFormat = format || (usesrgb ? gl.SRGB8_ALPHA8 : gl.RGBA)
      //console.log('initFromBytes',internalFormat)
      gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(data));
      //gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(data));
    };

    // uploads a Float32Array (RGBA, 0..1, sRGB-encoded — NOT yet linear) at full
    // precision, e.g. straight from a 16-bit raw decode. Bypasses the <img>/canvas
    // roundtrip that loadImage() requires, which would otherwise clamp to 8-bit.
    function loadFloatData(data, width, height){
      if(!txt) return console.error('texture has been destroyed')
      _width=width
      _height=height
      gl.bindTexture(gl.TEXTURE_2D, txt)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, width, height, 0, gl.RGBA, gl.FLOAT, data)
    }

    return {use, destroy, drawTo, loadImage, initFromBytes, loadFloatData}
}

function imagedata_to_image(imagedata, colorspace, type, quality) {
    const canvas = document.createElement('canvas');
    var ctx = canvas.getContext('2d',{ colorSpace: colorspace });
    canvas.width = imagedata.width;
    canvas.height = imagedata.height;
    ctx.putImageData(imagedata, 0, 0);

    var image = new Image();
    image.src = canvas.toDataURL(type, quality);
    return image;
}




