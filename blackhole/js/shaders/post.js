// Post-processing shaders: bloom pyramid, HDR composite, LDR grade.
// All passes run on a fullscreen triangle; see pipeline.js for orchestration.
//
// Order (fixed by spec):
//   raytrace HDR -> threshold -> downsample pyramid (>=5 levels)
//   -> upsample accumulate -> composite (HDR + bloom, exposure, ACES, sRGB)
//   -> grade (chromatic aberration, vignette, grain, Bayer dither)

// Shared fullscreen-triangle vertex shader. Expects a vec3 `position`
// attribute holding clip-space coords (-1,-1 .. 3,3).
// NOTE: no #version line — materials use glslVersion: THREE.GLSL3.
export const FS_VERT = /* glsl */ `
precision highp float;
in vec3 position;
out vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

// ------------------------------------------------------ bloom: threshold
export const THRESHOLD_FS = /* glsl */ `
precision highp float;
uniform sampler2D tSrc;
uniform float uThreshold;      // soft knee threshold (linear HDR)
in vec2 vUv;
out vec4 fragColor;
void main() {
  vec3 c = texture(tSrc, vUv).rgb;
  c = max(c, vec3(0.0));
  float l = max(max(c.r, c.g), c.b);
  // soft-knee: quadratic falloff just above threshold
  float knee = uThreshold * 0.5 + 1e-4;
  float soft = clamp(l - uThreshold + knee, 0.0, 2.0 * knee);
  soft = soft * soft / (4.0 * knee);
  float w = max(soft, l - uThreshold) / max(l, 1e-4);
  fragColor = vec4(c * w, 1.0);
}
`;

// ------------------------------------------------------ bloom: downsample
// 4-tap box with center bias (stable for HDR fireflies).
export const DOWN_FS = /* glsl */ `
precision highp float;
uniform sampler2D tSrc;
uniform vec2 uTexel;           // 1 / srcResolution
in vec2 vUv;
out vec4 fragColor;
void main() {
  vec3 s = texture(tSrc, vUv).rgb * 4.0;
  s += texture(tSrc, vUv + uTexel * vec2(-1.0, -1.0)).rgb;
  s += texture(tSrc, vUv + uTexel * vec2( 1.0, -1.0)).rgb;
  s += texture(tSrc, vUv + uTexel * vec2(-1.0,  1.0)).rgb;
  s += texture(tSrc, vUv + uTexel * vec2( 1.0,  1.0)).rgb;
  fragColor = vec4(s / 8.0, 1.0);
}
`;

// ------------------------------------------------------ bloom: upsample
// 3x3 tent filter of the smaller level, added onto the current level.
export const UP_FS = /* glsl */ `
precision highp float;
uniform sampler2D tSrc;        // smaller (more blurred) level
uniform sampler2D tAdd;        // current level
uniform vec2 uTexel;           // 1 / srcResolution (of tSrc)
uniform float uRadius;         // p17: tent contribution scale
in vec2 vUv;
out vec4 fragColor;
void main() {
  vec3 s = vec3(0.0);
  s += texture(tSrc, vUv + uTexel * vec2(-1.0, -1.0)).rgb * 1.0;
  s += texture(tSrc, vUv + uTexel * vec2( 0.0, -1.0)).rgb * 2.0;
  s += texture(tSrc, vUv + uTexel * vec2( 1.0, -1.0)).rgb * 1.0;
  s += texture(tSrc, vUv + uTexel * vec2(-1.0,  0.0)).rgb * 2.0;
  s += texture(tSrc, vUv).rgb * 4.0;
  s += texture(tSrc, vUv + uTexel * vec2( 1.0,  0.0)).rgb * 2.0;
  s += texture(tSrc, vUv + uTexel * vec2(-1.0,  1.0)).rgb * 1.0;
  s += texture(tSrc, vUv + uTexel * vec2( 0.0,  1.0)).rgb * 2.0;
  s += texture(tSrc, vUv + uTexel * vec2( 1.0,  1.0)).rgb * 1.0;
  vec3 up = s / 16.0;
  fragColor = vec4(texture(tAdd, vUv).rgb + up * uRadius, 1.0);
}
`;

// ------------------------------------------------------ composite (HDR->LDR)
// HDR + bloom*strength -> exposure 2^p15 -> saturation (linear) -> ACES once
// -> linear to sRGB. Output is display-ready LDR.
export const COMPOSITE_FS = /* glsl */ `
precision highp float;
uniform sampler2D tHDR;
uniform sampler2D tBloom;
uniform float uExposure;       // already 2^p15 on the JS side
uniform float uBloomStrength;  // p16
uniform float uSaturation;     // p21
in vec2 vUv;
out vec4 fragColor;

vec3 aces(vec3 x) {            // Narkowicz ACES fit, applied exactly once
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14),
               0.0, 1.0);
}
vec3 lin2srgb(vec3 c) {
  c = max(c, vec3(0.0));
  vec3 lo = c * 12.92;
  vec3 hi = 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055;
  return mix(lo, hi, step(vec3(0.0031308), c));
}
void main() {
  vec3 hdr = texture(tHDR, vUv).rgb;
  vec3 bloom = texture(tBloom, vUv).rgb;
  vec3 c = (hdr + uBloomStrength * bloom) * uExposure;
  c = max(c, vec3(0.0));
  float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(lum), c, uSaturation);   // saturation in linear, pre-ACES
  c = max(c, vec3(0.0));
  c = aces(c);
  fragColor = vec4(lin2srgb(c), 1.0);
}
`;

// ------------------------------------------------------ temporal accumulation
// Exponential history blend (TAA-lite): out = mix(history, current, uBlend).
// uBlend = 1 on invalidation (camera/param change), ~0.12 when settled.
export const ACCUM_FS = /* glsl */ `
precision highp float;
uniform sampler2D tCur;
uniform sampler2D tHist;
uniform float uBlend;
in vec2 vUv;
out vec4 fragColor;
void main() {
  vec4 c = texture(tCur, vUv);
  vec4 h = texture(tHist, vUv);
  fragColor = mix(h, c, uBlend);
}
`;

// ------------------------------------------------------ grade (post-sRGB)
// Radial chromatic aberration (bright edges only) -> vignette -> film grain
// -> 2x2 Bayer dither.
export const GRADE_FS = /* glsl */ `
precision highp float;
uniform sampler2D tLDR;
uniform vec2 uRes;
uniform float uTime;
uniform float uChroma;         // p19 default 0.004
uniform float uVignette;       // p20 default 0.45
uniform float uGrain;          // p18 default 0.06
in vec2 vUv;
out vec4 fragColor;

float ghash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
void main() {
  vec2 d = vUv - 0.5;
  float r2 = dot(d, d);

  vec3 base = texture(tLDR, vUv).rgb;
  float lum = dot(base, vec3(0.299, 0.587, 0.114));

  // radial CA, weighted to bright edges so the shadow center stays clean
  float caW = uChroma * smoothstep(0.12, 0.75, lum);
  vec3 col;
  col.r = texture(tLDR, vUv + d * caW * 2.0).r;
  col.g = base.g;
  col.b = texture(tLDR, vUv - d * caW * 2.0).b;

  // vignette
  col *= 1.0 - uVignette * smoothstep(0.12, 1.05, r2 * 2.0);

  // film grain, suppressed in deep shadows
  float n = ghash(gl_FragCoord.xy + fract(uTime * 61.7) * vec2(113.1, 271.7));
  col += (n - 0.5) * uGrain * (0.12 + 0.88 * lum);

  // 2x2 Bayer dither (1 LSB)
  vec2 fc = floor(gl_FragCoord.xy);
  float bx = mod(fc.x, 2.0);
  float by = mod(fc.y, 2.0);
  float bayer = (by < 0.5 ? (bx < 0.5 ? 0.0 : 2.0)
                          : (bx < 0.5 ? 3.0 : 1.0)) / 4.0;
  col += (bayer - 0.375) * (1.0 / 255.0);

  fragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`;
