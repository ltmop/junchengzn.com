// Render pipeline: HDR raytrace RT -> bloom pyramid -> composite -> grade.
// Owns all render targets, pass materials, and quality tiers.

import * as THREE from 'three';
import { RAYTRACE_FS } from './shaders/raytrace.js';
import {
  FS_VERT, THRESHOLD_FS, DOWN_FS, UP_FS, COMPOSITE_FS, GRADE_FS, ACCUM_FS,
} from './shaders/post.js';

export const QUALITY = {
  standard:  { scale: 0.8, maxSteps: 600,  dprCap: 1.5 },
  high:      { scale: 0.9, maxSteps: 1000, dprCap: 2.0 },
  cinematic: { scale: 1.0, maxSteps: 1600, dprCap: 2.0 },
};

const BLOOM_LEVELS = 6; // >= 5 downsample levels as specified

function detectHalfFloat(gl) {
  if (!gl.getExtension('EXT_color_buffer_float')) return false;
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, 4, 4, 0, gl.RGBA,
    gl.HALF_FLOAT, null);
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0,
    gl.TEXTURE_2D, tex, 0);
  const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fb);
  gl.deleteTexture(tex);
  return ok;
}

export class Pipeline {
  constructor(renderer, params, extParams) {
    this.renderer = renderer;
    this.params = params;               // shared PARAMS registry (main.js)
    this.ext = extParams || {};         // EXT_PARAMS (tintIn/tintOut/diskH)
    this.qualityName = 'high';
    this.bloomEnabled = true;
    this.bloomThreshold = 1.2;    // HDR prefilter knee — the photon ring and
                                  // doppler-boosted inner rim are far above 1,
                                  // so they still halo; the mid-bright disk
                                  // body stays below and doesn't fog the sky
    this.autoScale = 1.0;        // dynamic-resolution multiplier [0.4, 1]
    this.debugView = 0;
    // TAA-lite: sub-pixel jitter + exponential history accumulation
    this.accumEnabled = true;
    this.accumBlend = 0.08;      // new-frame weight when settled
    this.settledFrames = 0;      // consecutive accumulated (converging) frames
    this._invalid = true;
    this._frameSeq = 0;
    this._histFlip = false;

    // ---- half-float renderability, fallback to plain float
    const gl = renderer.getContext();
    this.halfFloat = detectHalfFloat(gl);
    renderer.resetState();
    this.rtType = this.halfFloat ? THREE.HalfFloatType : THREE.FloatType;

    // ---- fullscreen triangle
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(
      new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    this.triGeo = geo;
    this.scene = new THREE.Scene();
    this.mesh = new THREE.Mesh(geo, null);
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);
    this.dummyCam = new THREE.Camera();

    const matOpts = {
      depthTest: false, depthWrite: false,
      glslVersion: THREE.GLSL3,   // three prepends #version 300 es itself
    };

    // ---- raytrace material (uniforms wired by main.js via rayUniforms)
    this.rayUniforms = {
      uRes:        { value: new THREE.Vector2(1, 1) },
      uJitter:     { value: new THREE.Vector2(0, 0) },
      uCamPos:     { value: new THREE.Vector3() },
      uCamRight:   { value: new THREE.Vector3(1, 0, 0) },
      uCamUp:      { value: new THREE.Vector3(0, 0, 1) },
      uCamFwd:     { value: new THREE.Vector3(-1, 0, 0) },
      uTanHalfFov: { value: 0.4663 },
      uAspect:     { value: 1 },
      uTime:       { value: 0 },
      uMaxSteps:   { value: 1000 },
      uDebugView:  { value: 0 },
      uDiskIn:     { value: params.p04.value },
      uDiskOut:    { value: params.p05.value },
      uTempK:      { value: params.p06.value },
      uTurbAmp:    { value: params.p07.value },
      uTurbScale:  { value: params.p08.value },
      uTurbSpeed:  { value: params.p09.value },
      uDopplerBoost: { value: params.p10.value },
      uRedshiftMix: { value: params.p11.value },
      uMinStep:    { value: params.p12.value },
      uMaxStep:    { value: params.p13.value },
      uMaxCross:   { value: params.p14.value },
      uRMax:       { value: 50.0 },
      uTintIn:     { value: 2.4 },
      uTintOut:    { value: 0.78 },
      uDiskH:      { value: 0.08 },
      uNoLens:     { value: 0 },
      uNoDoppler:  { value: 0 },
      uNoRedshift: { value: 0 },
      uNoTurb:     { value: 0 },
    };
    this.matRay = new THREE.RawShaderMaterial({
      ...matOpts, uniforms: this.rayUniforms,
      vertexShader: FS_VERT, fragmentShader: RAYTRACE_FS,
    });

    // ---- post materials
    this.matThresh = new THREE.RawShaderMaterial({
      ...matOpts, vertexShader: FS_VERT, fragmentShader: THRESHOLD_FS,
      uniforms: { tSrc: { value: null }, uThreshold: { value: this.bloomThreshold } },
    });
    this.matDown = new THREE.RawShaderMaterial({
      ...matOpts, vertexShader: FS_VERT, fragmentShader: DOWN_FS,
      uniforms: { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() } },
    });
    this.matUp = new THREE.RawShaderMaterial({
      ...matOpts, vertexShader: FS_VERT, fragmentShader: UP_FS,
      uniforms: {
        tSrc: { value: null }, tAdd: { value: null },
        uTexel: { value: new THREE.Vector2() }, uRadius: { value: 0.85 },
      },
    });
    this.matAccum = new THREE.RawShaderMaterial({
      ...matOpts, vertexShader: FS_VERT, fragmentShader: ACCUM_FS,
      uniforms: {
        tCur: { value: null }, tHist: { value: null },
        uBlend: { value: 1.0 },
      },
    });
    this.matComposite = new THREE.RawShaderMaterial({
      ...matOpts, vertexShader: FS_VERT, fragmentShader: COMPOSITE_FS,
      uniforms: {
        tHDR: { value: null }, tBloom: { value: null },
        uExposure: { value: 1.0 }, uBloomStrength: { value: 1.1 },
        uSaturation: { value: 1.05 },
      },
    });
    this.matGrade = new THREE.RawShaderMaterial({
      ...matOpts, vertexShader: FS_VERT, fragmentShader: GRADE_FS,
      uniforms: {
        tLDR: { value: null },
        uRes: { value: new THREE.Vector2(1, 1) },
        uTime: { value: 0 },
        uChroma: { value: 0.004 }, uVignette: { value: 0.45 },
        uGrain: { value: 0.06 },
      },
    });

    this.rtHDR = null;
    this.rtLDR = null;
    this.bloomDown = [];   // bloomDown[0..N-1], halving
    this.bloomUp = [];     // accumulation targets, same sizes as bloomDown
    this.width = 0;
    this.height = 0;
  }

  // ---------------------------------------------------------- sizing
  setQuality(name) {
    if (QUALITY[name]) this.qualityName = name;
    this._allocate(true);
  }

  // dynamic-resolution fallback: multiplies the tier's base render scale
  setAutoScale(s) {
    s = Math.min(1, Math.max(0.4, s));
    if (s !== this.autoScale) {
      this.autoScale = s;
      this._allocate(true);
    }
  }

  setSize(cssW, cssH, devicePR) {
    const q = QUALITY[this.qualityName];
    const dpr = Math.min(devicePR, this.bgDprCap || q.dprCap);
    this.cssW = cssW;
    this.cssH = cssH;
    this.dpr = dpr;
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(
      Math.max(1, Math.round(cssW * dpr)),
      Math.max(1, Math.round(cssH * dpr)), false);
    this._allocate();
  }

  _allocate(force = false) {
    if (!this.cssW) return;
    const q = QUALITY[this.qualityName];
    const scale = q.scale * this.autoScale;
    const w = Math.max(1, Math.round(this.cssW * this.dpr * scale));
    const h = Math.max(1, Math.round(this.cssH * this.dpr * scale));
    if (!force && w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;

    this._disposeRTs();
    const hdrOpts = {
      type: this.rtType, format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      depthBuffer: false, stencilBuffer: false,
    };
    this.rtHDR = new THREE.WebGLRenderTarget(w, h, hdrOpts);
    // TAA history ping-pong pair, same format as the HDR target
    this.rtHistA = new THREE.WebGLRenderTarget(w, h, hdrOpts);
    this.rtHistB = new THREE.WebGLRenderTarget(w, h, hdrOpts);
    this._invalid = true;          // history is stale after (re)allocation
    this.settledFrames = 0;
    this.rtLDR = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.UnsignedByteType, format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      depthBuffer: false, stencilBuffer: false,
    });

    let bw = w >> 1, bh = h >> 1;
    for (let i = 0; i < BLOOM_LEVELS; i++) {
      bw = Math.max(4, bw); bh = Math.max(4, bh);
      this.bloomDown.push(new THREE.WebGLRenderTarget(bw, bh, hdrOpts));
      this.bloomUp.push(new THREE.WebGLRenderTarget(bw, bh, hdrOpts));
      bw >>= 1; bh >>= 1;
    }
  }

  _disposeRTs() {
    if (this.rtHDR) this.rtHDR.dispose();
    if (this.rtLDR) this.rtLDR.dispose();
    if (this.rtHistA) this.rtHistA.dispose();
    if (this.rtHistB) this.rtHistB.dispose();
    for (const rt of this.bloomDown) rt.dispose();
    for (const rt of this.bloomUp) rt.dispose();
    this.bloomDown = [];
    this.bloomUp = [];
  }

  // ---------------------------------------------------------- per-frame
  syncParams() {
    const p = this.params, u = this.rayUniforms;
    this.matThresh.uniforms.uThreshold.value = this.bloomThreshold;
    u.uDiskIn.value = p.p04.value;
    u.uDiskOut.value = p.p05.value;
    u.uTempK.value = p.p06.value;
    u.uTurbAmp.value = p.p07.value;
    u.uTurbScale.value = p.p08.value;
    u.uTurbSpeed.value = p.p09.value;
    u.uDopplerBoost.value = p.p10.value;
    u.uRedshiftMix.value = p.p11.value;
    u.uMinStep.value = p.p12.value;
    u.uMaxStep.value = p.p13.value;
    u.uMaxCross.value = Math.round(p.p14.value);
    u.uMaxSteps.value = QUALITY[this.qualityName].maxSteps;
    const x = this.ext;
    if (x.tintIn) u.uTintIn.value = x.tintIn.value;
    if (x.tintOut) u.uTintOut.value = x.tintOut.value;
    if (x.diskH) u.uDiskH.value = x.diskH.value;
    const dv = this.debugView | 0;
    u.uDebugView.value = dv;
    // physics-control flags are derived from the active debug view
    u.uNoLens.value = dv === 2 ? 1 : 0;
    u.uNoDoppler.value = dv === 3 ? 1 : 0;
    u.uNoRedshift.value = dv === 4 ? 1 : 0;
    u.uNoTurb.value = dv === 5 ? 1 : 0;
    this.matComposite.uniforms.uExposure.value = Math.pow(2, p.p15.value);
    this.matComposite.uniforms.uBloomStrength.value = p.p16.value;
    this.matUp.uniforms.uRadius.value = p.p17.value;
    this.matGrade.uniforms.uGrain.value = p.p18.value;
    this.matGrade.uniforms.uChroma.value = p.p19.value;
    this.matGrade.uniforms.uVignette.value = p.p20.value;
    this.matComposite.uniforms.uSaturation.value = p.p21.value;
  }

  // ---------------------------------------------------------- TAA-lite
  // Mark the accumulation history stale (camera moved, param changed,
  // resize, quality switch, debug-view switch). Next frame blends fully.
  invalidate() {
    this._invalid = true;
    this.settledFrames = 0;
  }

  _halton(i, b) {
    let f = 1, r = 0;
    while (i > 0) { f /= b; r += f * (i % b); i = Math.floor(i / b); }
    return r;
  }

  render(time, debugView = 0) {
    this.debugView = debugView;
    this.syncParams();
    if (!this.rtHDR) return;   // zero-size host (hidden iframe): nothing to draw
    const r = this.renderer;
    const { scene, dummyCam } = this;
    const run = (mat, target) => {
      this.mesh.material = mat;
      r.setRenderTarget(target);
      r.render(scene, dummyCam);
    };

    // 1. raytrace -> HDR (with sub-pixel jitter while accumulating)
    const u = this.rayUniforms;
    u.uRes.value.set(this.width, this.height);
    u.uTime.value = time;
    const useAccum = this.accumEnabled && debugView === 0;
    if (useAccum && !this._invalid) {
      const s = this._frameSeq % 8;
      u.uJitter.value.set(this._halton(s + 1, 2) - 0.5,
        this._halton(s + 1, 3) - 0.5);
    } else {
      u.uJitter.value.set(0, 0);
    }
    run(this.matRay, this.rtHDR);

    // 1b. temporal accumulation: bloom + composite read the settled image
    let hdrTex = this.rtHDR.texture;
    if (useAccum) {
      const blend = this._invalid ? 1.0 : this.accumBlend;
      const src = this._histFlip ? this.rtHistB : this.rtHistA;
      const dst = this._histFlip ? this.rtHistA : this.rtHistB;
      const au = this.matAccum.uniforms;
      au.tCur.value = this.rtHDR.texture;
      au.tHist.value = this._invalid ? this.rtHDR.texture : src.texture;
      au.uBlend.value = blend;
      run(this.matAccum, dst);
      this._histFlip = !this._histFlip;
      hdrTex = dst.texture;
    }
    this._invalid = false;
    this.settledFrames++;
    this._frameSeq++;

    // 2-4. bloom pyramid (composite view only; debug views render clean)
    const rawOnly = (debugView !== 0);
    let bloomTex = null;
    if (!rawOnly) {
      const N = this.bloomDown.length;
      this.matThresh.uniforms.tSrc.value = hdrTex;
      run(this.matThresh, this.bloomDown[0]);
      for (let i = 1; i < N; i++) {
        this.matDown.uniforms.tSrc.value = this.bloomDown[i - 1].texture;
        this.matDown.uniforms.uTexel.value.set(
          1 / this.bloomDown[i - 1].width, 1 / this.bloomDown[i - 1].height);
        run(this.matDown, this.bloomDown[i]);
      }
      let cur = this.bloomDown[N - 1];
      for (let i = N - 2; i >= 0; i--) {
        this.matUp.uniforms.tSrc.value = cur.texture;
        this.matUp.uniforms.tAdd.value = this.bloomDown[i].texture;
        this.matUp.uniforms.uTexel.value.set(1 / cur.width, 1 / cur.height);
        run(this.matUp, this.bloomUp[i]);
        cur = this.bloomUp[i];
      }
      bloomTex = cur.texture;
    }

    // 5. composite HDR + bloom -> LDR (sRGB)
    const cu = this.matComposite.uniforms;
    cu.tHDR.value = hdrTex;
    cu.tBloom.value = rawOnly ? this.blackTex() : bloomTex;
    if (rawOnly) {
      // temporarily neutralize bloom contribution
      cu.uBloomStrength.value = 0.0;
    }
    run(this.matComposite, this.rtLDR);

    // 6. grade -> screen
    const gu = this.matGrade.uniforms;
    gu.tLDR.value = this.rtLDR.texture;
    gu.uRes.value.set(this.renderer.domElement.width,
      this.renderer.domElement.height);
    gu.uTime.value = time;
    run(this.matGrade, null);
  }

  blackTex() {
    if (!this._blackTex) {
      this._blackTex = new THREE.DataTexture(
        new Uint8Array([0, 0, 0, 255]), 1, 1);
      this._blackTex.needsUpdate = true;
    }
    return this._blackTex;
  }
}
