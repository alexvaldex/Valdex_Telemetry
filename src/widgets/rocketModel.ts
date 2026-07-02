import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";

export type Model3D = {
  name: string;
  mime: string;
  dataUrl: string; // base64 data url
  uploadedAt: number;
};

/** Which local CAD axis points "up" (toward the nose) in the uploaded file. */
export type UpAxis = "x" | "y" | "z" | "-x" | "-y" | "-z";

function dataUrlToArrayBuffer(dataUrl: string): ArrayBuffer {
  const base64 = dataUrl.split(",")[1] ?? "";
  const bin = atob(base64);
  const len = bin.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

export async function loadModelObject(model: Model3D): Promise<THREE.Object3D> {
  const name = model.name.toLowerCase();

  if (name.endsWith(".glb") || name.endsWith(".gltf")) {
    const loader = new GLTFLoader();
    const ab = dataUrlToArrayBuffer(model.dataUrl);
    const blobUrl = URL.createObjectURL(new Blob([ab], { type: "model/gltf-binary" }));
    try {
      const gltf = await loader.loadAsync(blobUrl);
      return gltf.scene;
    } finally {
      URL.revokeObjectURL(blobUrl);
    }
  }

  if (name.endsWith(".stl")) {
    const loader = new STLLoader();
    const ab = dataUrlToArrayBuffer(model.dataUrl);
    const geom = loader.parse(ab);
    geom.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({ color: "#cfd6e6", metalness: 0.25, roughness: 0.55 });
    return new THREE.Mesh(geom, mat);
  }

  if (name.endsWith(".obj")) {
    const loader = new OBJLoader();
    const ab = dataUrlToArrayBuffer(model.dataUrl);
    const text = new TextDecoder().decode(new Uint8Array(ab));
    const obj = loader.parse(text);
    obj.traverse((c: any) => {
      if (c?.isMesh && !c.material) c.material = new THREE.MeshStandardMaterial({ color: "#cfd6e6", metalness: 0.2, roughness: 0.6 });
    });
    return obj;
  }

  throw new Error("Unsupported model format. Use .glb / .gltf (recommended), .stl, or .obj");
}

/**
 * Rotate the object so the chosen source axis becomes +Y (nose up), then
 * recenter and scale to a target long-axis size. Returns the wrapper group
 * whose local +Y is the rocket's nose direction — apply the flight quaternion
 * to a parent of this group.
 */
export function normalizeModel(obj: THREE.Object3D, upAxis: UpAxis, targetSize = 1.4): THREE.Group {
  // orientation: map source up-axis onto +Y
  switch (upAxis) {
    case "y": break;
    case "-y": obj.rotation.x = Math.PI; break;
    case "z": obj.rotation.x = -Math.PI / 2; break;
    case "-z": obj.rotation.x = Math.PI / 2; break;
    case "x": obj.rotation.z = Math.PI / 2; break;
    case "-x": obj.rotation.z = -Math.PI / 2; break;
  }
  obj.updateMatrixWorld(true);

  const box = new THREE.Box3().setFromObject(obj);
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);

  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  const scale = targetSize / maxDim;

  // Wrap so we can center+scale without fighting the orientation rotation.
  const wrapper = new THREE.Group();
  obj.position.sub(center);
  wrapper.add(obj);
  wrapper.scale.setScalar(scale);
  return wrapper;
}
