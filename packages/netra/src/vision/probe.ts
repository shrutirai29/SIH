/**
 * NETRA Capability Probe & Micro-benchmark (ticket C1).
 *
 * Runs an install-time or startup micro-benchmark (matmuls + GPU probe)
 * to honestly categorize the device capability into:
 *  - Class A: discrete GPU / fast WebGPU accelerator (250ms budget)
 *  - Class B: modern integrated GPU / fast multi-core CPU (450ms budget)
 *  - Class C: WASM-only fallback (1200ms budget)
 */

import type { DeviceClass, DeviceProfile, ExecutionProvider } from '../index.js';

/**
 * Runs a matrix multiplication micro-benchmark to measure actual client compute throughput.
 * Multiplies two 64x64 float matrices for N iterations.
 */
export function runMatmulMicroBenchmark(iterations = 30): number {
  const N = 64;
  const a = new Float32Array(N * N);
  const b = new Float32Array(N * N);
  const c = new Float32Array(N * N);

  for (let i = 0; i < N * N; i++) {
    a[i] = (i % 17) * 0.1;
    b[i] = (i % 23) * 0.1;
  }

  const start = performance.now();

  for (let iter = 0; iter < iterations; iter++) {
    for (let i = 0; i < N; i++) {
      const iOffset = i * N;
      for (let k = 0; k < N; k++) {
        const aVal = a[iOffset + k]!;
        const kOffset = k * N;
        for (let j = 0; j < N; j++) {
          c[iOffset + j] = c[iOffset + j]! + aVal * b[kOffset + j]!;
        }
      }
    }
  }

  const elapsedMs = Math.max(0.1, performance.now() - start);
  const ops = iterations * 2 * N * N * N; // 2*N^3 FLOPs per matmul
  const mflops = (ops / (elapsedMs / 1000)) / 1e6;

  return mflops;
}

/**
 * Probes the execution environment and benchmarks performance to determine DeviceProfile.
 */
export async function probeDeviceWithBenchmark(): Promise<DeviceProfile> {
  const cores = typeof navigator === 'undefined' ? 1 : (navigator.hardwareConcurrency || 2);
  const gpu = (globalThis.navigator as Navigator & {
    gpu?: { requestAdapter(): Promise<{ limits?: { maxComputeWorkgroupSizeX?: number } } | null> };
  })?.gpu;

  let ep: ExecutionProvider = 'wasm';
  let hasWebGpu = false;

  if (gpu !== undefined) {
    try {
      const adapter = await gpu.requestAdapter();
      if (adapter !== null) {
        hasWebGpu = true;
        ep = 'webgpu';
      }
    } catch {
      // GPU adapter probe rejected or unavailable
      hasWebGpu = false;
      ep = 'wasm';
    }
  }

  // Run the micro-benchmark
  const mflops = runMatmulMicroBenchmark(30);

  let deviceClass: DeviceClass;
  let tier2BudgetMs: number;

  if (hasWebGpu && (mflops > 120 || cores >= 8)) {
    deviceClass = 'A';
    tier2BudgetMs = 250;
  } else if (hasWebGpu || mflops > 50 || cores >= 4) {
    deviceClass = 'B';
    tier2BudgetMs = 450;
  } else {
    deviceClass = 'C';
    tier2BudgetMs = 1200;
  }

  return {
    deviceClass,
    ep,
    cores,
    tier2BudgetMs,
  };
}
