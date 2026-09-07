// Cinematic camera shots. Normalized timeline t in [0,1), loops forever,
// easeInOutCubic easing. While playing, OrbitControls must be disabled by
// the caller; the shot drives the camera through the applyCam callback
// (r, thetaDeg, phiDeg) every frame.

export function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

export const SHOTS = [
  {
    id: 'A',
    name: 'DEEP ORBIT',
    duration: 48,               // seconds per loop
    // r breathes 8..22, theta sweeps 30..85, one full revolution per loop
    pose(t) {
      const e = easeInOutCubic(t < 0.5 ? t * 2 : 2 - t * 2);
      return {
        r: 15 - 7 * Math.cos(2 * Math.PI * t),
        theta: 30 + 55 * e,
        phi: 360 * t,
      };
    },
  },
  {
    id: 'B',
    name: 'EDGE-ON PASS',
    duration: 60,
    // hugging the disk plane, steady azimuth drift, r micro-breath 8..11
    pose(t) {
      return {
        r: 9.5 + 1.5 * Math.sin(2 * Math.PI * t),
        theta: 88 - 1.5 * easeInOutCubic(0.5 - 0.5 * Math.cos(2 * Math.PI * t)),
        phi: 360 * t,
      };
    },
  },
];

export class Cinematic {
  constructor(applyCam) {
    this.applyCam = applyCam;    // (r, thetaDeg, phiDeg) => void
    this.shotIndex = 0;
    this.playing = false;
    this.phase = 0;
    this.onStateChange = null;   // (playing) => void — caller disables input
  }

  get shot() { return SHOTS[this.shotIndex]; }

  setShot(i) {
    this.shotIndex = ((i % SHOTS.length) + SHOTS.length) % SHOTS.length;
    this.phase = 0;
    if (this.playing) this._apply();
  }

  toggleShot() { this.setShot(this.shotIndex + 1); }

  play() {
    this.playing = true;
    this._apply();
    if (this.onStateChange) this.onStateChange(true);
  }
  pause() {
    this.playing = false;
    if (this.onStateChange) this.onStateChange(false);
  }
  toggle() { this.playing ? this.pause() : this.play(); return this.playing; }

  update(dt) {
    if (!this.playing) return;
    this.phase = (this.phase + dt / this.shot.duration) % 1;
    this._apply();
  }

  _apply() {
    const p = this.shot.pose(this.phase);
    this.applyCam(p.r, p.theta, p.phi);
  }
}
