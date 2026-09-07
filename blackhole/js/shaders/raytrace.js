// RAYTRACE_FS — Schwarzschild black-hole ray tracer (Gullstrand–Painlevé,
// Cartesian form). Units: G = c = 1, radii in r_s = 2M. Horizon r=1,
// photon sphere r=1.5, ISCO r=3. Camera = static distant observer, null
// geodesics integrated backwards per pixel with adaptive RK4.
//
// The physics kernel is exposed as traceRay() returning a TraceResult so
// future debug views (uDebugView 0..9) can reuse it unchanged.
//
// NOTE: sources carry no #version line on purpose — materials are created
// with glslVersion: THREE.GLSL3 so three.js prepends it before its own
// #define prologue.

export const RAYTRACE_FS = /* glsl */ `
precision highp float;
precision highp int;

// ---------------------------------------------------------------- uniforms
uniform vec2  uRes;
uniform vec2  uJitter;      // sub-pixel jitter in pixel units (TAA)
uniform vec3  uCamPos;
uniform vec3  uCamRight;
uniform vec3  uCamUp;
uniform vec3  uCamFwd;
uniform float uTanHalfFov;
uniform float uAspect;
uniform float uTime;
uniform int   uMaxSteps;
uniform int   uDebugView;   // 0 = composite source, 9 = raw linear HDR

// p-params (p01 r0 / p02 theta are camera-side, handled in JS)
uniform float uDiskIn;        // p04  default 3.0
uniform float uDiskOut;       // p05  default 14.0
uniform float uTempK;         // p06  default 6500 K
uniform float uTurbAmp;       // p07  default 0.6
uniform float uTurbScale;     // p08  default 1.0
uniform float uTurbSpeed;     // p09  default 0.35
uniform float uDopplerBoost;  // p10  default 3.0
uniform float uRedshiftMix;   // p11  default 1.0 (0 = pure doppler)
uniform float uMinStep;       // p12  default 2e-3
uniform float uMaxStep;       // p13  default 0.3
uniform int   uMaxCross;      // p14  default 3 (0..8)
uniform float uRMax;          // escape radius, default 50

// extension params (aesthetics group; do not alter p01..p21 semantics)
uniform float uTintIn;        // inner-rim temperature stretch, default 2.2
uniform float uTintOut;       // outer-rim temperature stretch, default 0.55
uniform float uDiskH;         // disk scale height h/r, 0 = thin plane, default 0.08

// debug control flags (0.0 off / 1.0 on). Composite view: all zero.
// They are set from uDebugView on the JS side but stay independent uniforms
// so later phases can toggle them individually.
uniform float uNoLens;        // view 2: straight-line analytic comparison
uniform float uNoDoppler;     // view 3: doppler factor -> 1
uniform float uNoRedshift;    // view 4: gravitational redshift factor -> 1
uniform float uNoTurb;        // view 5: turbulence -> flat

out vec4 fragColor;

const int MAX_STEPS = 1600;   // hard GLSL loop ceiling (Cinematic)

// ---------------------------------------------------------------- hashes
float hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}
vec3 hash33(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.xxy + p.yxx) * p.zyx);
}

// ------------------------------------------------------- value noise / fbm
float vnoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  vec3 u = f * f * (3.0 - 2.0 * f);
  float n000 = hash13(i + vec3(0.0, 0.0, 0.0));
  float n100 = hash13(i + vec3(1.0, 0.0, 0.0));
  float n010 = hash13(i + vec3(0.0, 1.0, 0.0));
  float n110 = hash13(i + vec3(1.0, 1.0, 0.0));
  float n001 = hash13(i + vec3(0.0, 0.0, 1.0));
  float n101 = hash13(i + vec3(1.0, 0.0, 1.0));
  float n011 = hash13(i + vec3(0.0, 1.0, 1.0));
  float n111 = hash13(i + vec3(1.0, 1.0, 1.0));
  return mix(mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y),
             mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y), u.z);
}
float fbm(vec3 p) {
  float a = 0.5;
  float s = 0.0;
  for (int i = 0; i < 4; i++) {
    s += a * vnoise(p);
    p = p * 2.03 + vec3(17.3, 9.1, 4.7);
    a *= 0.5;
  }
  return s; // ~[0, 1)
}
// Finer, higher-contrast variant used by the disk turbulence: 5 octaves and
// sharper value range so the disk reads as chaotic clumps, not a smooth ramp.
float fbm5(vec3 p) {
  float a = 0.5;
  float s = 0.0;
  for (int i = 0; i < 5; i++) {
    s += a * vnoise(p);
    p = p * 2.17 + vec3(11.3, 7.7, 3.9);
    a *= 0.5;
  }
  return s; // ~[0, 1)
}

// ------------------------------------------------------------- blackbody
// Tanner Helland style Planckian locus fit, T in Kelvin -> linear RGB.
vec3 blackbody(float T) {
  T = clamp(T, 800.0, 40000.0) / 100.0;
  float r, g, b;
  r = T <= 66.0 ? 255.0 : 329.698727446 * pow(T - 60.0, -0.1332047592);
  g = T <= 66.0 ? 99.4708025861 * log(T) - 161.1195681661
                : 288.1221695283 * pow(T - 60.0, -0.0755148492);
  b = T >= 66.0 ? 255.0
                : (T <= 19.0 ? 0.0 : 138.5177312231 * log(T - 10.0) - 305.0447927307);
  vec3 c = clamp(vec3(r, g, b) / 255.0, 0.0, 1.0);
  return pow(c, vec3(2.2)); // sRGB-ish decode to linear
}

// ----------------------------------------------------------- starfield
// Purely procedural: 3 cell layers, per-cell Poisson occupancy, power-law
// magnitudes (few bright, many dim), temperature spread from orange dwarfs
// to blue-white. Star discs are softened against the pixel footprint so
// they don't shimmer under camera motion; a gentle HDR soft-cap keeps the
// brightest stars from nuking the bloom chain.
vec3 starLayer(vec3 d, float scale, float density, float gain, float seed,
               float pixCell, float dustMask, float bandBoost) {
  vec3 p = d * scale;
  vec3 cell = floor(p);
  vec3 f = fract(p);
  if (hash13(cell + seed) > density * (1.0 + bandBoost)) return vec3(0.0);
  vec3 sp = 0.2 + 0.6 * hash33(cell + seed + 3.1);
  float dist = length(f - sp);
  float mag = pow(hash13(cell + seed + 7.7), 4.0);       // magnitude power law
  float tK = mix(2600.0, 12000.0, pow(hash13(cell + seed + 9.3), 1.6));
  float size = max(0.055, pixCell * 1.3);                // anti-flicker floor
  float star = 1.0 - smoothstep(size * 0.25, size, dist);
  float amp = (0.06 + 18.0 * mag) * gain;
  amp = amp / (1.0 + amp * 0.04);                        // soft HDR cap
  return star * amp * blackbody(tK) * dustMask;
}

vec3 sky(vec3 d) {
  // Galactic band: a great-circle belt tilted ~60 deg to the disk plane.
  // Brightness = gaussian waist * (1 + fbm wisps), split by a dust lane
  // offset half a bandwidth (multiplicative extinction). Star density
  // rises inside the band.
  vec3 gn = normalize(vec3(0.194, 0.844, 0.5)); // galactic normal: 60 deg
  // tilt from the disk plane, azimuth chosen so the band crosses the
  // default framing's visible sky
  vec3 t1 = normalize(cross(gn, vec3(0.0, 1.0, 0.13)));
  vec3 t2 = cross(gn, t1);
  float gc = dot(d, gn);                        // sine of galactic latitude
  float lon = atan(dot(d, t1), dot(d, t2));     // galactic longitude

  float band = exp(-pow(gc / 0.22, 2.0));
  float wisp = fbm(vec3(lon * 2.2, gc * 7.0, 3.7));
  float wisp2 = fbm(vec3(lon * 5.1 + 8.0, gc * 14.0, 8.2));

  float laneN = fbm(vec3(lon * 4.0 + 17.0, gc * 18.0, 5.5));
  float lane = exp(-pow((gc - 0.10) / 0.06, 2.0)) * (0.35 + 0.65 * laneN);
  float dustMask = 1.0 - 0.85 * lane;

  vec3 mwTint = mix(vec3(0.38, 0.40, 0.52), vec3(0.72, 0.62, 0.50), wisp);
  vec3 col = band * (0.5 + 1.6 * wisp + 0.55 * wisp2) * mwTint * 0.32;
  col *= dustMask;

  // stars: three scales, denser inside the band — sparse enough to read
  // as individual points, not noise
  float pixAng = 2.0 * uTanHalfFov / uRes.y;    // radians per pixel
  float bandBoost = 1.5 * band;
  col += starLayer(d, 55.0, 0.045, 1.5, 0.0,  pixAng * 55.0, dustMask, bandBoost);
  col += starLayer(d, 130.0, 0.075, 0.8, 17.7, pixAng * 130.0, dustMask, bandBoost);
  col += starLayer(d, 300.0, 0.13, 0.4, 41.3, pixAng * 300.0, dustMask, bandBoost);

  // faint blue-ish floor so deep space is not pure black (kept under ~0.03
  // sRGB so it cannot lift the sky into a grey wash)
  col += vec3(0.003, 0.0035, 0.0055);
  return col;
}

// ------------------------------------------------------------- geodesic
// State derivative, GP Cartesian form. v = dt/dλ, w = dx/dλ.
void deriv(in vec3 x, in float v, in vec3 w,
           out vec3 dx, out float dv, out vec3 dw) {
  float r = length(x);
  vec3 xh = x / r;
  float beta = inversesqrt(r);              // r^{-1/2}
  float S = dot(xh, w);
  float w2 = dot(w, w);
  float Q0 = -v * S / (r * r) + beta * (w2 - 1.5 * S * S) / r;
  dv = Q0 - beta * v * v / (2.0 * r * r);
  float k = v * v * (1.0 - beta * beta) / (2.0 * r * r) + beta * Q0;
  dx = w;
  dw = -xh * k;
}

void rk4(inout vec3 x, inout float v, inout vec3 w, float h) {
  vec3 k1x, k1w, k2x, k2w, k3x, k3w, k4x, k4w;
  float k1v, k2v, k3v, k4v;
  deriv(x, v, w, k1x, k1v, k1w);
  deriv(x + 0.5 * h * k1x, v + 0.5 * h * k1v, w + 0.5 * h * k1w, k2x, k2v, k2w);
  deriv(x + 0.5 * h * k2x, v + 0.5 * h * k2v, w + 0.5 * h * k2w, k3x, k3v, k3w);
  deriv(x + h * k3x, v + h * k3v, w + h * k3w, k4x, k4v, k4w);
  x += (h / 6.0) * (k1x + 2.0 * k2x + 2.0 * k3x + k4x);
  v += (h / 6.0) * (k1v + 2.0 * k2v + 2.0 * k3v + k4v);
  w += (h / 6.0) * (k1w + 2.0 * k2w + 2.0 * k3w + k4w);
}

// Domain-warp displacement for the disk turbulence, computed once per
// crossing (it varies slowly across the slab) and reused by all sub-samples.
vec2 diskWarp(vec3 xs, float Omega) {
  float ang = Omega * uTime * uTurbSpeed;
  float ca = cos(ang), sa = sin(ang);
  vec2 q = vec2(xs.x * ca - xs.y * sa, xs.x * sa + xs.y * ca);
  vec2 qn = q * (uTurbScale * 0.5);
  return vec2(fbm5(vec3(qn, uTime * 0.02)) - 0.5,
              fbm5(vec3(qn.yx + 4.7, uTime * 0.02)) - 0.5) * 2.4;
}

// ------------------------------------------------------------- disk hit
// Emission + opacity at one point inside the disk. rgb = linear HDR emission,
// a = local opacity [0,1]. wc is the RAW geodesic velocity (dx/dλ) — its
// magnitude feeds the doppler term, so do not pass a normalized vector here.
// wp is the precomputed domain-warp (see diskWarp).
vec4 diskPoint(vec3 xs, vec3 wc, float E0, int n, vec2 wp) {
  float rd = length(xs.xy);
  if (rd < uDiskIn || rd > uDiskOut) return vec4(0.0);

  // exact GR redshift decomposed: g = g_grav * g_doppler
  //   g_grav = 1/u^t = sqrt(1 - 1.5/r)   (gravitational + transverse)
  //   g_dop  = E / (E - Ω Lz)            (special-relativistic beaming)
  float Lz = xs.x * wc.y - xs.y * wc.x;
  float Omega = inversesqrt(2.0 * rd * rd * rd); // Keplerian, these units
  float gGrav = sqrt(max(1.0 - 1.5 / rd, 0.0));
  gGrav = mix(1.0, gGrav, uRedshiftMix);          // p11
  if (uNoRedshift > 0.5) gGrav = 1.0;
  float gDop = E0 / max(E0 - Omega * Lz, 1e-4);
  if (uNoDoppler > 0.5) gDop = 1.0;
  float g = max(gGrav * gDop, 1e-4);

  // vertical gaussian falloff inside the finite-thickness layer (h/r = uDiskH)
  float Hs = max(uDiskH * rd, 1e-4);
  float vert = uDiskH > 1e-3 ? exp(-pow(xs.z / Hs, 2.0)) : 1.0;

  // Turbulence: chaotic, self-shearing structure. Differential rotation
  // (Keplerian Omega(r), inner faster) winds the noise into vortices; a domain
  // warp de-correlates the fields; a ridged octave carves filamentary 'rubble'
  // clumps. The third noise coordinate carries normalized height, so the
  // clumps have vertical structure inside the thick disk.
  float turb = 0.5;
  if (uNoTurb < 0.5) {
    float ang = Omega * uTime * uTurbSpeed;
    float ca = cos(ang), sa = sin(ang);
    vec2 q = vec2(xs.x * ca - xs.y * sa, xs.x * sa + xs.y * ca);
    vec2 qn = q * (uTurbScale * 0.5) + wp;
    float qz = uDiskH > 1e-3 ? xs.z / Hs : 0.0;
    float tn = fbm5(vec3(qn, qz * 1.8 + uTime * 0.034));
    float rid = 1.0 - abs(2.0 * tn - 1.0);
    turb = mix(tn, rid, 0.5);
  }
  float T = uTempK * pow(uDiskIn / rd, 0.75);
  // turbulence brightness modulation, floored: gaps go dim but never to zero,
  // otherwise they absorb without emitting and the disk turns to murk
  T *= max(1.0 + uTurbAmp * (turb - 0.5) * 2.4, 0.18);
  float Tobs = max(g * T, 300.0);
  // Aesthetic temperature stretch (deliberately non-physical hue shift,
  // applied after the relativistic g factor): inner rim pushed blue-white,
  // outer rim pulled dark red — the Interstellar grade. Luminance-preserving:
  // the tinted blackbody is renormalized to the physical blackbody's
  // luminance, so the HDR energy chain (exposure, bloom, beam) is untouched
  // and only the hue moves. uTintIn = uTintOut = 1 disables it.
  // Ramp exponent < 1 concentrates the blue push at the inner rim: with 1.7
  // the stretch lingered near uTintIn across most of the disk and the whole
  // body read white; 0.25 crosses neutral by rd~5 so only the photon-ring
  // vicinity glows blue-white, the mid disk stays warm orange and the outer
  // edge sinks to deep red — clear layering, restrained.
  float tTint = mix(uTintIn, uTintOut,
                    pow(smoothstep(uDiskIn, uDiskOut, rd), 0.25));
  vec3 bbPhys = blackbody(Tobs);
  vec3 bbAes  = blackbody(max(Tobs * tTint, 300.0));
  const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
  vec3 bb = bbAes * (dot(bbPhys, LUMA) / max(dot(bbAes, LUMA), 1e-4));

  // radial profile + edge feather, feather narrows for higher-order images
  float feather = 0.6 * pow(0.7, float(n));
  float aIn = smoothstep(uDiskIn, uDiskIn + feather, rd);
  float aOut = 1.0 - smoothstep(uDiskOut - feather, uDiskOut, rd);
  // density/extinction modulation (scaled by uTurbAmp): clumps are opaque &
  // bright, gaps let you see through to the far side / background — this is
  // what gives the disk interior 'space' and rubble instead of a solid band.
  float density = mix(1.0 - 0.6 * uTurbAmp, 1.0 + 0.45 * uTurbAmp, turb);
  float alpha = clamp(aIn * aOut * density * vert, 0.0, 1.0);
  float profile = pow(uDiskIn / rd, 2.2);

  float boost = pow(max(g, 1e-4), uDopplerBoost);
  vec3 emission = bb * (profile * boost * 1.0);
  return vec4(emission, alpha);
}

// Accumulate one disk-layer crossing, front-to-back.
// Returns 1.0 when the crossing actually contributed (inside the disk).
// uDiskH == 0: classic infinitesimally-thin plane, single sample (original
// behavior). uDiskH > 0: slab of half-thickness (h/r)·r around z = 0,
// sub-sampled 4x along the local ray direction with slant correction, so a
// grazing (edge-on) ray accumulates a longer luminous path and the disk reads
// as a glowing band with thickness instead of a hairline.
float diskCrossing(vec3 xc, vec3 wc, float E0, int n,
                   inout vec3 col, inout float trans) {
  float rd = length(xc.xy);
  if (rd < uDiskIn || rd > uDiskOut) return 0.0;
  float wgt = pow(0.6, float(n));            // secondary images dimmer
  float OmegaC = inversesqrt(2.0 * rd * rd * rd);
  vec2 wp = uNoTurb < 0.5 ? diskWarp(xc, OmegaC) : vec2(0.0);

  if (uDiskH < 1e-3) {
    vec4 e = diskPoint(xc, wc, E0, n, wp);
    col += trans * (wgt * e.a) * e.rgb;
    trans *= 1.0 - wgt * e.a;
    return 1.0;
  }

  vec3 wn = normalize(wc);                   // marching direction only
  float slope = max(abs(wn.z), 0.16);        // clamp grazing blow-up
  float Hc = uDiskH * rd;
  float hp = min(Hc / slope, Hc * 2.2);      // half path; short enough that
                                             // the rubble texture survives
  for (int k = 0; k < 3; k++) {
    float fk = (float(k) + 0.5) / 3.0 * 2.0 - 1.0; // -0.667, 0, +0.667
    vec3 xs = xc + wn * (fk * hp);
    vec4 e = diskPoint(xs, wc, E0, n, wp);
    float a = e.a * 0.42;                    // per-sample share (~renorm)
    col += trans * (wgt * a) * e.rgb;
    trans *= 1.0 - wgt * a;
  }
  return 1.0;
}

// ------------------------------------------------------------- tracer
struct TraceResult {
  vec3 color;       // linear HDR
  float steps;      // RK4 iterations used
  float crossings;  // disk-plane crossings consumed
  float hitType;    // 0 = escaped, 1 = captured, 2 = max steps
  float firstHit;   // order of first effective disk hit (0 = none)
  vec3 escDir;      // final escape direction (if escaped)
};

TraceResult traceRay(vec3 ro, vec3 rd) {
  TraceResult res;
  res.color = vec3(0.0);
  res.steps = 0.0;
  res.crossings = 0.0;
  res.hitType = 2.0;
  res.firstHit = 0.0;
  res.escDir = rd;

  // ------------------------------------------------ view 2: lens disabled
  // Straight-line analytic comparison path (debug only): single plane
  // crossing + spherical occlusion by the horizon. NOT used for the
  // composite view; it exists to prove the lensing comes from integration.
  if (uNoLens > 0.5) {
    float transS = 1.0;
    float b = length(cross(ro, rd));      // impact parameter of the line
    float tca = -dot(ro, rd);             // parameter of closest approach
    bool blocked = (b < 1.0 && tca > 0.0);
    if (abs(rd.z) > 1e-6 && uMaxCross > 0) {
      float t = -ro.z / rd.z;
      if (t > 0.0 && !(blocked && tca < t)) {
        vec3 xc = ro + rd * t;
        float hit = diskCrossing(xc, rd, 1.0, 0, res.color, transS);
        res.crossings = 1.0;
        if (hit > 0.5) res.firstHit = 1.0;
      }
    }
    if (blocked) {                        // line passes through the horizon
      res.hitType = 1.0;
      return res;
    }
    res.color += transS * sky(rd);
    res.hitType = 0.0;
    return res;
  }

  vec3 x = ro;
  vec3 w = rd;
  float r0 = length(x);
  float beta0 = inversesqrt(r0);
  float S0 = dot(x / r0, w);
  float v = 1.0 / (sqrt(1.0 - beta0 * beta0 + beta0 * beta0 * S0 * S0) - beta0 * S0);

  // conserved energy (used for the redshift at every disk crossing)
  float E0 = (1.0 - beta0 * beta0) * v - beta0 * S0;

  float trans = 1.0;
  int nCross = 0;
  float eTol = 0.02 * max(abs(E0), 0.5);   // energy-drift retry threshold

  vec3 xPrev = x;
  vec3 wPrev = w;
  float vPrev = v;
  bool wasInLayer = false;

  for (int i = 0; i < MAX_STEPS; i++) {
    if (i >= uMaxSteps) break;
    res.steps = float(i + 1);

    float r = length(x);

    // adaptive step: local curvature scale, refined near photon sphere/disk
    float h = clamp(0.05 * r * sqrt(max(r - 0.9, 0.0)), uMinStep, uMaxStep);
    if (abs(r - 1.5) < 0.5) h = min(h, 0.015);
    float rr = length(x.xy);
    float diskBand = max(0.35, uDiskH * rr + 0.1);
    if (abs(x.z) < diskBand && rr > uDiskIn - 1.0 && rr < uDiskOut + 1.0)
      h = min(h, 0.02);

    xPrev = x;
    wPrev = w;
    vPrev = v;
    rk4(x, v, w, h);

    // energy-conservation guard: on drift beyond tolerance, redo the step
    // as two half steps (local error drops ~16x)
    {
      float rn = length(x);
      float bn = inversesqrt(rn);
      float Sn = dot(x / rn, w);
      float En = (1.0 - bn * bn) * v - bn * Sn;
      if (abs(En - E0) > eTol) {
        x = xPrev; v = vPrev; w = wPrev;
        float h2 = 0.5 * h;
        rk4(x, v, w, h2);
        rk4(x, v, w, h2);
      }
    }

    // disk-layer interaction. Two triggers:
    //  - z sign change: the ray pierced the mid-plane (classic crossing)
    //  - outside->inside slab transition: catches rays that enter the thick
    //    layer radially (edge-on front rim) without ever crossing z = 0
    bool zcross = xPrev.z * x.z < 0.0;
    bool layerTouch = false;
    if (uDiskH > 1e-3) {
      float rrL = length(x.xy);
      float hTol = uDiskH * rrL * 1.15 + 0.05;
      layerTouch = abs(x.z) < hTol
        && rrL > uDiskIn - 1.0 && rrL < uDiskOut + 1.0;
      if (layerTouch) {
        // do not entry-trigger for plunging rays: a ray diving into the
        // horizon would otherwise deposit dim mid-disk murk over the shadow.
        // Legit rim entries (edge-on front face) move tangentially, S ≈ 0.
        float rNow = length(x);
        float SNow = dot(x / rNow, w);
        if (SNow < -0.25) layerTouch = false;
      }
    }
    if ((zcross || (layerTouch && !wasInLayer)) && nCross < uMaxCross) {
      float t = zcross ? xPrev.z / (xPrev.z - x.z) : 1.0;
      vec3 xc = mix(xPrev, x, t);
      vec3 wc = mix(wPrev, w, t);
      float hit = diskCrossing(xc, wc, E0, nCross, res.color, trans);
      nCross++;
      res.crossings = float(nCross);
      if (hit > 0.5 && res.firstHit < 0.5) res.firstHit = float(nCross);
    }
    wasInLayer = layerTouch;

    r = length(x);
    float S = dot(x / r, w);
    if (r < 1.03 && S < 0.0) {           // captured by the horizon
      res.hitType = 1.0;
      return res;
    }
    // early escape: well past the disk, moving outward and off the disk
    // plane — residual bending is far below a pixel, sample the sky now
    float escEarly = max(uDiskOut + 4.0, 16.0);
    if (r > escEarly && S > 0.0 && abs(x.z) > 2.0) {
      vec3 dir = normalize(w);
      res.color += trans * sky(dir);
      res.hitType = 0.0;
      res.escDir = dir;
      return res;
    }
    if (r > uRMax) {                      // escaped to the sky
      vec3 dir = normalize(w);
      res.color += trans * sky(dir);
      res.hitType = 0.0;
      res.escDir = dir;
      return res;
    }
  }
  return res; // hitType 2: step budget exhausted -> stays black
}

// ------------------------------------------------------- debug palettes
// Inferno polynomial fit (public-domain approximation, G. Numez / mpl).
vec3 inferno(float t) {
  t = clamp(t, 0.0, 1.0);
  const vec3 c0 = vec3(0.0002189403691192265, 0.001651004631001012, -0.01948089878709184);
  const vec3 c1 = vec3(0.1065134194856116, 0.5639564367884091, 3.932712388889277);
  const vec3 c2 = vec3(11.60249308283487, -3.97266696596548, -15.9423941062914);
  const vec3 c3 = vec3(-41.70399613139459, 17.43639888205313, 44.35414519872813);
  const vec3 c4 = vec3(77.162935699427, -33.40235894210092, -81.80730925738993);
  const vec3 c5 = vec3(-71.31942824499214, 32.62606426397723, 73.20951985803202);
  const vec3 c6 = vec3(25.13112622477341, -12.24266895238567, -23.07032500287172);
  return clamp(c0 + t * (c1 + t * (c2 + t * (c3 + t * (c4 + t * (c5 + t * c6))))),
               0.0, 1.0);
}

vec3 crossingColor(float n) {          // view 6: plane crossings 0/1/2/3+
  if (n < 0.5) return vec3(0.015, 0.02, 0.05);
  if (n < 1.5) return vec3(0.11, 0.62, 0.85);
  if (n < 2.5) return vec3(1.0, 0.62, 0.25);
  return vec3(1.0, 0.15, 0.35);
}

vec3 hitColor(TraceResult res) {       // view 7: hit classification
  if (res.hitType > 1.5) return vec3(0.9, 0.05, 0.05);       // step limit
  if (res.firstHit > 2.5) return vec3(0.85, 0.2, 0.9);       // 3rd+ image
  if (res.firstHit > 1.5) return vec3(1.0, 0.62, 0.2);       // 2nd image
  if (res.firstHit > 0.5) return vec3(0.2, 0.9, 0.35);       // direct hit
  if (res.hitType > 0.5) return vec3(0.0);                   // horizon
  return vec3(0.08, 0.12, 0.22);                             // open sky
}

vec3 zoneColor(vec3 hdr) {             // view 8: log2 exposure bands
  float lum = dot(hdr, vec3(0.2126, 0.7152, 0.0722));
  float z = log2(max(lum, 1e-5));
  float band = floor(z);
  vec3 base = inferno(clamp((band + 6.0) / 12.0, 0.0, 1.0));
  float stripe = 0.8 + 0.2 * step(0.5, fract(z));
  return base * stripe;
}

void main() {
  vec2 uv = ((gl_FragCoord.xy + uJitter) / uRes) * 2.0 - 1.0;
  vec3 dir = normalize(uCamFwd
      + uv.x * uTanHalfFov * uAspect * uCamRight
      + uv.y * uTanHalfFov * uCamUp);
  TraceResult res = traceRay(uCamPos, dir);
  vec3 col = max(res.color, vec3(0.0)); // clamp negatives (half-float safety)

  // uDebugView contract — every branch below is a re-colouring of the SAME
  // traceRay() result; nothing is drawn by a separate code path.
  if (uDebugView == 1) {
    // 1 = per-pixel iteration count, inferno heat map
    col = inferno(res.steps / float(uMaxSteps));
  } else if (uDebugView == 6) {
    // 6 = disk-plane crossing count
    col = crossingColor(res.crossings);
  } else if (uDebugView == 7) {
    // 7 = hit classification
    col = hitColor(res);
  } else if (uDebugView == 8) {
    // 8 = HDR luminance zones (log2 exposure bands)
    col = zoneColor(res.color);
  }
  // 0 = composite source, 2..5 = flag-driven re-colours of the physics,
  // 9 = raw linear HDR (post pipeline bypasses bloom for non-zero views).
  fragColor = vec4(col, res.hitType);
}
`;
