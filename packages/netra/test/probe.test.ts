import { describe, expect, it } from 'vitest';
import { runMatmulMicroBenchmark, probeDeviceWithBenchmark } from '../src/vision/probe.js';
import { probeDevice } from '../src/index.js';

describe('NETRA Capability Probe & Micro-Benchmark (Ticket C1)', () => {
  it('runs matrix multiplication micro-benchmark and yields positive throughput', () => {
    const mflops = runMatmulMicroBenchmark(10);
    expect(mflops).toBeGreaterThan(0);
    expect(Number.isFinite(mflops)).toBe(true);
  });

  it('probes device capabilities and returns a valid DeviceProfile', async () => {
    const profile = await probeDeviceWithBenchmark();

    expect(['A', 'B', 'C']).toContain(profile.deviceClass);
    expect(['webgpu', 'wasm']).toContain(profile.ep);
    expect(profile.cores).toBeGreaterThanOrEqual(1);
    expect([250, 450, 1200]).toContain(profile.tier2BudgetMs);
  });

  it('top-level probeDevice() delegates to benchmark probe', async () => {
    const profile = await probeDevice();
    expect(profile).toBeDefined();
    expect(profile.tier2BudgetMs).toBeGreaterThan(0);
  });
});
