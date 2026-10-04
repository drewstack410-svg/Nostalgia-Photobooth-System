/**
 * GPU LUT for the live camera preview. Uses a 2D slice atlas (not
 * TEXTURE_3D) so ANGLE/Electron kiosks still get the look at ~60fps.
 * Layout matches applyLutToImageData: index = r + g*n + b*n*n.
 */

import type { ParsedLut } from "./lut";

const VS = `#version 300 es
in vec2 aPos;
out vec2 vUv;
uniform vec2 uMirror;
uniform vec4 uUvRect;
void main() {
  vec2 unit = aPos * 0.5 + 0.5;
  if (uMirror.x > 0.5) unit.x = 1.0 - unit.x;
  vUv = mix(uUvRect.xy, uUvRect.zw, unit);
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FS = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uImage;
uniform sampler2D uLut;
uniform float uUseLut;
uniform float uSize;
vec3 sampleLut(vec3 c) {
  float n = uSize;
  float s = n - 1.0;
  float slice = c.b * s;
  float slice0 = floor(slice);
  float slice1 = min(s, slice0 + 1.0);
  float f = slice - slice0;
  float rf = c.r * s + 0.5;
  float gf = (c.g * s + 0.5) / n;
  float width = n * n;
  vec3 a = texture(uLut, vec2((slice0 * n + rf) / width, gf)).rgb;
  vec3 b = texture(uLut, vec2((slice1 * n + rf) / width, gf)).rgb;
  return mix(a, b, f);
}
void main() {
  vec4 c = texture(uImage, vUv);
  if (uUseLut > 0.5) {
    fragColor = vec4(sampleLut(clamp(c.rgb, 0.0, 1.0)), c.a);
  } else {
    fragColor = c;
  }
}`;

export type LiveLutGl = {
  draw: (
    source: TexImageSource,
    srcW: number,
    srcH: number,
    destW: number,
    destH: number,
    lut: ParsedLut | null,
    mirror: boolean,
  ) => boolean;
  destroy: () => void;
};

function compile(gl: WebGL2RenderingContext, type: number, src: string) {
  const sh = gl.createShader(type);
  if (!sh) return null;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    console.warn("[LiveLutGL] Shader:", gl.getShaderInfoLog(sh));
    gl.deleteShader(sh);
    return null;
  }
  return sh;
}

export function createLiveLutGl(
  canvas: HTMLCanvasElement,
): LiveLutGl | null {
  const gl = canvas.getContext("webgl2", {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    preserveDrawingBuffer: true,
    powerPreference: "high-performance",
  });
  if (!gl) {
    console.warn("[LiveLutGL] WebGL2 unavailable");
    return null;
  }
  const fail = (): null => {
    try {
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    } catch {
      /* ignore */
    }
    return null;
  };

  const vs = compile(gl, gl.VERTEX_SHADER, VS);
  const fs = compile(gl, gl.FRAGMENT_SHADER, FS);
  if (!vs || !fs) return fail();
  const prog = gl.createProgram();
  if (!prog) return fail();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.bindAttribLocation(prog, 0, "aPos");
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    console.warn("[LiveLutGL] Program:", gl.getProgramInfoLog(prog));
    return fail();
  }

  const buf = gl.createBuffer();
  const imageTex = gl.createTexture();
  const lutTex = gl.createTexture();
  const uImage = gl.getUniformLocation(prog, "uImage");
  const uLut = gl.getUniformLocation(prog, "uLut");
  const uUseLut = gl.getUniformLocation(prog, "uUseLut");
  const uSize = gl.getUniformLocation(prog, "uSize");
  const uMirror = gl.getUniformLocation(prog, "uMirror");
  const uUvRect = gl.getUniformLocation(prog, "uUvRect");

  let lutKey = "";
  let destroyed = false;

  function bindQuad() {
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
      gl.STATIC_DRAW,
    );
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  }

  function uploadLut(lut: ParsedLut) {
    const key = `${lut.size}:${lut.data.length}`;
    if (key === lutKey) return;
    lutKey = key;
    const n = lut.size;
    const rgba = new Uint8Array(n * n * n * 4);
    let p = 0;
    for (let b = 0; b < n; b++) {
      for (let g = 0; g < n; g++) {
        for (let r = 0; r < n; r++) {
          const i = (r + g * n + b * n * n) * 3;
          rgba[p++] = Math.max(0, Math.min(255, Math.round(lut.data[i] * 255)));
          rgba[p++] = Math.max(
            0,
            Math.min(255, Math.round(lut.data[i + 1] * 255)),
          );
          rgba[p++] = Math.max(
            0,
            Math.min(255, Math.round(lut.data[i + 2] * 255)),
          );
          rgba[p++] = 255;
        }
      }
    }
    // Atlas: each B slice is a n×n block along X. Row is G.
    const atlas = new Uint8Array(n * n * n * 4);
    let o = 0;
    for (let g = 0; g < n; g++) {
      for (let b = 0; b < n; b++) {
        for (let r = 0; r < n; r++) {
          const src = (r + g * n + b * n * n) * 4;
          atlas[o++] = rgba[src];
          atlas[o++] = rgba[src + 1];
          atlas[o++] = rgba[src + 2];
          atlas[o++] = 255;
        }
      }
    }
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, lutTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      n * n,
      n,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      atlas,
    );
  }

  bindQuad();
  gl.useProgram(prog);
  gl.uniform1i(uImage, 0);
  gl.uniform1i(uLut, 1);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, imageTex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  return {
    draw(source, srcW, srcH, destW, destH, lut, mirror) {
      if (destroyed) return false;
      if (canvas.width !== destW) canvas.width = destW;
      if (canvas.height !== destH) canvas.height = destH;
      gl.viewport(0, 0, destW, destH);
      gl.useProgram(prog);
      bindQuad();
      gl.uniform2f(uMirror, mirror ? 1 : 0, 0);
      const imgA = srcW / Math.max(1, srcH);
      const canA = destW / Math.max(1, destH);
      let u0 = 0;
      let v0 = 0;
      let u1 = 1;
      let v1 = 1;
      if (imgA > canA) {
        const uw = canA / imgA;
        u0 = (1 - uw) / 2;
        u1 = u0 + uw;
      } else if (canA > imgA) {
        const vh = imgA / canA;
        v0 = (1 - vh) / 2;
        v1 = v0 + vh;
      }
      gl.uniform4f(uUvRect, u0, v0, u1, v1);
      if (lut && lut.size > 1) {
        uploadLut(lut);
        gl.uniform1f(uUseLut, 1);
        gl.uniform1f(uSize, lut.size);
      } else {
        gl.uniform1f(uUseLut, 0);
      }
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, lutTex);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, imageTex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
      try {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
      } catch (e) {
        console.warn("[LiveLutGL] texImage2D failed:", e);
        return false;
      }
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      return true;
    },
    destroy() {
      destroyed = true;
      try {
        gl.deleteTexture(imageTex);
        gl.deleteTexture(lutTex);
        gl.deleteBuffer(buf);
        gl.deleteProgram(prog);
        gl.deleteShader(vs);
        gl.deleteShader(fs);
        gl.getExtension("WEBGL_lose_context")?.loseContext();
      } catch {
        /* ignore */
      }
    },
  };
}
