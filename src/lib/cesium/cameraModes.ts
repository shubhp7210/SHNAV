import {
  CesiumWidget, Cartesian3, HeadingPitchRange, Matrix4, Math as CMath,
} from "cesium";
import type { Pt, TargetView } from "@/lib/geo/region";

export type CameraMode = "follow" | "forward" | "overview" | "free";
export const CAMERA_MODES: CameraMode[] = ["follow", "forward", "overview", "free"];

interface Vehicle { lat: number; lng: number; heading: number; speedKmh: number; ts: number; alt?: number }

/** Interpolated camera rig state (ground-anchored target + spherical offset). */
interface Rig { lat: number; lng: number; alt: number; heading: number; pitch: number; range: number }

// Easing rate toward the goal, per second (≈0.09/frame at 60 fps). Time-based,
// so the camera trails the vehicle by the same distance at any frame rate — a
// per-frame factor let slow GPUs fall hundreds of metres behind (vehicle
// off-screen).
const SMOOTH_PER_SEC = 5.5;
// Gentler rate for the opening glide from the starting view (Manhattan) to the
// vehicle, so the hand-off reads as a deliberate camera move, not a snap.
const INTRO_PER_SEC = 1.6;
const INTRO_MS = 2600;
const M_PER_DEG = 111_320;

/** Shortest signed angular delta a→b, in radians (handles 180° wraparound). */
function angleLerp(a: number, b: number, k: number): number {
  let d = ((b - a + Math.PI) % (2 * Math.PI)) - Math.PI;
  if (d < -Math.PI) d += 2 * Math.PI;
  return a + d * k;
}

/**
 * Smooth, mode-driven camera for the flying-car view. Runs its own rAF so camera
 * motion is smooth regardless of telemetry cadence. Telemetry only sets targets
 * (setVehicle); the rig eases toward them. Stale/out-of-order telemetry is the
 * caller's concern — this controller simply holds the last target, never
 * fabricating motion.
 */
export class CameraController {
  private widget: CesiumWidget;
  private mode: CameraMode = "follow";
  private route: Pt[] = [];
  private vehicle: Vehicle | null = null;
  private rig: Rig | null = null;
  private raf = 0;
  private lastFrame = 0;
  private disposed = false;
  private introUntil = 0;
  // Smoothed target velocity (deg/s) — fed forward so the rig doesn't trail a
  // fast vehicle by speed/rate metres. Low-passed so 1 Hz GPS steps stay smooth.
  private vel = { lat: 0, lng: 0 };
  private lastGoal: { lat: number; lng: number; mode: CameraMode } | null = null;

  constructor(widget: CesiumWidget, start?: TargetView) {
    this.widget = widget;
    if (start) {
      this.rig = {
        lat: start.lat, lng: start.lng, alt: 0,
        heading: CMath.toRadians(start.heading), pitch: CMath.toRadians(start.pitch), range: start.range,
      };
      this.introUntil = performance.now() + INTRO_MS;
    }
    this.loop = this.loop.bind(this);
    this.raf = requestAnimationFrame(this.loop);
  }

  setMode(mode: CameraMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    const ssc = this.widget.scene.screenSpaceCameraController;
    if (mode === "free") {
      // Release the locked reference frame and hand control to the user.
      this.widget.camera.lookAtTransform(Matrix4.IDENTITY);
      ssc.enableInputs = true;
    } else {
      ssc.enableInputs = false;
    }
  }

  getMode(): CameraMode { return this.mode; }

  /** Switch back to automatic following. */
  recenter(): void { this.setMode("follow"); }

  setRoute(route: Pt[]): void { this.route = route; }

  /** Feed the latest vehicle telemetry. Out-of-order samples are ignored. */
  setVehicle(v: Vehicle): void {
    if (this.vehicle && v.ts < this.vehicle.ts) return; // drop stale/out-of-order
    this.vehicle = v;
  }

  private goal(): Rig | null {
    const v = this.vehicle;
    if (this.mode === "overview") {
      if (this.route.length < 2) return v ? { lat: v.lat, lng: v.lng, alt: 0, heading: 0, pitch: -0.9, range: 1500 } : null;
      // Frame the whole route: centroid + range from its span.
      let minLat = 90, maxLat = -90, minLng = 180, maxLng = -180;
      for (const p of this.route) {
        minLat = Math.min(minLat, p.lat); maxLat = Math.max(maxLat, p.lat);
        minLng = Math.min(minLng, p.lng); maxLng = Math.max(maxLng, p.lng);
      }
      const spanM = Math.max(
        (maxLat - minLat) * M_PER_DEG,
        (maxLng - minLng) * M_PER_DEG * Math.cos(CMath.toRadians((minLat + maxLat) / 2)),
      );
      return { lat: (minLat + maxLat) / 2, lng: (minLng + maxLng) / 2, alt: 0, heading: 0, pitch: -0.95, range: Math.max(800, spanM * 1.6) };
    }
    if (!v) return null;
    const hdg = CMath.toRadians(v.heading);
    if (this.mode === "forward") {
      // Look further ahead as speed rises (reveal upcoming turns/terrain).
      const lookAheadM = 300 + Math.min(1200, v.speedKmh * 12);
      const dLat = (lookAheadM * Math.cos(hdg)) / M_PER_DEG;
      const dLng = (lookAheadM * Math.sin(hdg)) / (M_PER_DEG * Math.cos(CMath.toRadians(v.lat)));
      return { lat: v.lat + dLat, lng: v.lng + dLng, alt: (v.alt ?? 0) * 0.5, heading: hdg, pitch: -0.32, range: 900 };
    }
    // follow
    return { lat: v.lat, lng: v.lng, alt: v.alt ?? 0, heading: hdg, pitch: -0.45, range: 600 };
  }

  private loop(now: number): void {
    if (this.disposed) return;
    // Clamp dt so a backgrounded tab doesn't snap on return.
    const dt = this.lastFrame ? Math.min(0.25, (now - this.lastFrame) / 1000) : 1 / 60;
    this.lastFrame = now;
    const rate = now < this.introUntil ? INTRO_PER_SEC : SMOOTH_PER_SEC;
    const SMOOTH = 1 - Math.exp(-rate * dt);
    if (this.mode !== "free") {
      const goal = this.goal();
      if (goal) {
        if (!this.rig) this.rig = { ...goal };
        const r = this.rig;
        const lg = this.lastGoal;
        if (lg && lg.mode === this.mode && dt > 0) {
          const k = 1 - Math.exp(-3 * dt);
          this.vel.lat += ((goal.lat - lg.lat) / dt - this.vel.lat) * k;
          this.vel.lng += ((goal.lng - lg.lng) / dt - this.vel.lng) * k;
        } else {
          this.vel = { lat: 0, lng: 0 }; // first frame or mode switch: no feed-forward
        }
        this.lastGoal = { lat: goal.lat, lng: goal.lng, mode: this.mode };
        if (now >= this.introUntil) {
          r.lat += this.vel.lat * dt;
          r.lng += this.vel.lng * dt;
        }
        r.lat += (goal.lat - r.lat) * SMOOTH;
        r.lng += (goal.lng - r.lng) * SMOOTH;
        r.alt += (goal.alt - r.alt) * SMOOTH;
        r.pitch += (goal.pitch - r.pitch) * SMOOTH;
        r.range += (goal.range - r.range) * SMOOTH;
        r.heading = angleLerp(r.heading, goal.heading, SMOOTH);
        this.widget.camera.lookAt(
          Cartesian3.fromDegrees(r.lng, r.lat, r.alt),
          new HeadingPitchRange(r.heading, r.pitch, r.range),
        );
        // Explicit-render mode: only draw while the rig is still moving.
        const moving =
          Math.abs(goal.lat - r.lat) + Math.abs(goal.lng - r.lng) > 1e-7 ||
          Math.abs(goal.range - r.range) > 0.05 || Math.abs(goal.pitch - r.pitch) > 1e-4 ||
          Math.abs(goal.alt - r.alt) > 0.05 || Math.abs(angleLerp(r.heading, goal.heading, 1) - r.heading) > 1e-4;
        if (moving) this.widget.scene.requestRender();
      }
    }
    this.raf = requestAnimationFrame(this.loop);
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    if (!this.widget.isDestroyed()) {
      this.widget.camera.lookAtTransform(Matrix4.IDENTITY);
    }
  }
}
