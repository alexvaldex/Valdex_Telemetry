import * as THREE from "three";
import React, { useEffect, useRef, useState } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";

import {
  getRocketConfig,
  getVehicleModel,
  VEHICLE_CHANGED_EVENT,
  derivePhase,
  phaseIndex,
  type RocketConfig,
  type FlightPhase,
} from "../telemetry/vehicleStore";
import { loadModelObject, normalizeModel } from "./rocketModel";

type Q = { w: number; x: number; y: number; z: number } | null;

/** Procedural fallback airframe — nose points +Y, tail toward -Y. */
function ProceduralAirframe({ color = "#cfd6e6", accent = "#7aa2ff" }: { color?: string; accent?: string }) {
  return (
    <group>
      <mesh>
        <cylinderGeometry args={[0.08, 0.08, 1.0, 24]} />
        <meshStandardMaterial color={color} metalness={0.25} roughness={0.45} />
      </mesh>
      <mesh position={[0, 0.6, 0]}>
        <coneGeometry args={[0.09, 0.28, 24]} />
        <meshStandardMaterial color="#e9eefc" metalness={0.15} roughness={0.35} />
      </mesh>
      {[0, 120, 240].map((d) => (
        <mesh key={d} rotation={[0, (d * Math.PI) / 180, 0]} position={[0.11, -0.42, 0]}>
          <boxGeometry args={[0.02, 0.2, 0.24]} />
          <meshStandardMaterial color={accent} metalness={0.2} roughness={0.5} />
        </mesh>
      ))}
    </group>
  );
}

/** Parachute canopy (hemisphere + riser), scaled by an animated group. */
function Parachute({ color, y }: { color: string; y: number }) {
  return (
    <group position={[0, y, 0]}>
      <mesh rotation={[Math.PI, 0, 0]}>
        <sphereGeometry args={[0.5, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2]} />
        <meshStandardMaterial color={color} side={THREE.DoubleSide} metalness={0} roughness={0.95} />
      </mesh>
      <mesh position={[0, -0.28, 0]}>
        <cylinderGeometry args={[0.004, 0.004, 0.56, 6]} />
        <meshStandardMaterial color="#ffffff" />
      </mesh>
    </group>
  );
}

function Scene(props: {
  q: Q;
  config: RocketConfig;
  sustainer: THREE.Object3D | null;
  booster: THREE.Object3D | null;
  phase: FlightPhase;
}) {
  const { q, config, sustainer, booster, phase } = props;
  const pIdx = phaseIndex(phase);

  const vehicleRef = useRef<THREE.Group>(null);
  const boosterRef = useRef<THREE.Group>(null);
  const drogueRef = useRef<THREE.Group>(null);
  const mainRef = useRef<THREE.Group>(null);
  const flameRef = useRef<THREE.Mesh>(null);
  const anim = useRef({ boosterY: 0, boosterRot: 0, drogue: 0, main: 0, flame: 0, idle: 0 });

  const sepIdx =
    config.separationEvent === "APOGEE" ? phaseIndex("APOGEE")
    : config.separationEvent === "BURNOUT" ? phaseIndex("COAST")
    : 999;
  const separated = config.stages === 2 && pIdx >= sepIdx;

  const boostPhase = pIdx === phaseIndex("BOOST");
  const droguePhase = pIdx === phaseIndex("DROGUE") && config.recovery === "drogue-main";
  const mainPhase = pIdx >= phaseIndex("MAIN") && pIdx < phaseIndex("LANDED") && config.recovery !== "none";

  const sustainerY = config.stages === 2 ? 0.5 : 0;

  useFrame((_, dt) => {
    const a = anim.current;
    const k = (rate: number) => Math.min(1, dt * rate);

    if (vehicleRef.current) {
      if (q) {
        vehicleRef.current.quaternion.set(q.x, q.y, q.z, q.w);
      } else {
        // No attitude data — slow idle spin so the model reads as 3D.
        a.idle += dt * 0.4;
        vehicleRef.current.rotation.set(0, a.idle, 0);
      }
    }

    // Stage separation: booster falls away and tumbles.
    const targetY = separated ? -2.6 : 0;
    a.boosterY += (targetY - a.boosterY) * k(2);
    if (separated) a.boosterRot += dt * 1.6;
    if (boosterRef.current) {
      boosterRef.current.position.y = -0.6 + a.boosterY;
      boosterRef.current.rotation.z = a.boosterRot;
    }

    // Chute deploys.
    a.drogue += ((droguePhase ? 1 : 0) - a.drogue) * k(4);
    a.main += ((mainPhase ? 1 : 0) - a.main) * k(4);
    if (drogueRef.current) {
      drogueRef.current.scale.setScalar(a.drogue * 0.55 + 0.0001);
      drogueRef.current.visible = a.drogue > 0.02;
    }
    if (mainRef.current) {
      mainRef.current.scale.setScalar(a.main + 0.0001);
      mainRef.current.visible = a.main > 0.02;
    }

    // Boost flame flicker.
    a.flame += ((boostPhase ? 1 : 0) - a.flame) * k(6);
    if (flameRef.current) {
      flameRef.current.scale.set(1, a.flame * (0.8 + Math.random() * 0.4), 1);
      flameRef.current.visible = a.flame > 0.02;
    }
  });

  return (
    <>
      <ambientLight intensity={0.6} />
      <directionalLight position={[5, 6, 4]} intensity={0.95} />
      <directionalLight position={[-4, 2, -3]} intensity={0.3} />

      {/* ground + grid */}
      <gridHelper args={[14, 28, "#33507f" as any, "#16233b" as any]} position={[0, -1.6, 0]} />

      <group ref={vehicleRef}>
        {/* Sustainer / upper stage */}
        <group position={[0, sustainerY, 0]}>
          {sustainer ? <primitive object={sustainer} /> : <ProceduralAirframe />}

          {/* Recovery chutes above the nose */}
          <group ref={drogueRef} visible={false}>
            <Parachute color="#ff8b3a" y={1.25} />
          </group>
          <group ref={mainRef} visible={false}>
            <Parachute color="#3aa0ff" y={1.7} />
          </group>
        </group>

        {/* Booster / lower stage (only shown for two-stage) */}
        {config.stages === 2 && (
          <group ref={boosterRef} position={[0, -0.6, 0]}>
            {booster ? <primitive object={booster} /> : <ProceduralAirframe color="#b9c0d0" accent="#ff8b3a" />}
          </group>
        )}

        {/* Boost flame at the tail */}
        <mesh ref={flameRef} position={[0, config.stages === 2 ? -1.25 : -0.62, 0]} visible={false}>
          <coneGeometry args={[0.07, 0.5, 16, 1, true]} />
          <meshStandardMaterial color="#ffb02e" emissive="#ff5a1f" emissiveIntensity={2} transparent opacity={0.85} />
        </mesh>
      </group>

      <OrbitControls enablePan={false} />
    </>
  );
}

/** Real-time 3D rocket viewer driven by telemetry quaternion + flight phase. */
export default function RocketViewer(props: { q: Q; frames: Array<{ t_ms: number; event?: string }>; tMs: number }) {
  const [config, setConfig] = useState<RocketConfig>(() => getRocketConfig());
  const [sustainer, setSustainer] = useState<THREE.Object3D | null>(null);
  const [booster, setBooster] = useState<THREE.Object3D | null>(null);
  const [status, setStatus] = useState<string>("");

  useEffect(() => {
    let alive = true;

    async function load() {
      const cfg = getRocketConfig();
      if (alive) setConfig(cfg);
      try {
        const [sModel, bModel] = await Promise.all([getVehicleModel("sustainer"), getVehicleModel("booster")]);
        if (!alive) return;

        if (sModel) {
          const obj = normalizeModel(await loadModelObject(sModel), cfg.upAxis, 1.4 * cfg.modelScale);
          if (alive) setSustainer(obj); else return;
        } else {
          setSustainer(null);
        }

        if (bModel && cfg.stages === 2) {
          const obj = normalizeModel(await loadModelObject(bModel), cfg.upAxis, 1.4 * cfg.modelScale);
          if (alive) setBooster(obj);
        } else {
          setBooster(null);
        }
        if (alive) setStatus("");
      } catch (e: any) {
        if (alive) setStatus(e?.message ?? "Model load failed");
      }
    }

    load();
    const onChange = () => load();
    window.addEventListener(VEHICLE_CHANGED_EVENT, onChange);
    return () => {
      alive = false;
      window.removeEventListener(VEHICLE_CHANGED_EVENT, onChange);
    };
  }, []);

  const phase = derivePhase(props.frames, props.tMs);

  return (
    <div
      style={{ position: "relative", height: "100%", minHeight: 260, borderRadius: 3, overflow: "hidden", border: "1px solid var(--vx-line)" }}
      // Orbiting the model must never start a grid drag/resize.
      onMouseDown={(e) => e.stopPropagation()}
      onTouchStart={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <Canvas camera={{ position: [2.8, 1.4, 2.8], fov: 50 }}>
        <Scene q={props.q} config={config} sustainer={sustainer} booster={booster} phase={phase} />
      </Canvas>

      {/* Phase / config HUD overlay */}
      <div style={{ position: "absolute", left: 8, top: 8, display: "flex", gap: 6, alignItems: "center", pointerEvents: "none" }}>
        <span className="vx-chip" style={{ background: "rgba(4,7,14,0.7)" }}>{phase}</span>
        {config.stages === 2 && <span className="vx-chip" style={{ background: "rgba(4,7,14,0.7)" }}>2-STAGE</span>}
      </div>
      {status && (
        <div style={{ position: "absolute", left: 8, bottom: 8, right: 8, fontSize: 11, color: "var(--vx-crit)", fontFamily: "var(--vx-font-mono)" }}>
          {status}
        </div>
      )}
    </div>
  );
}
