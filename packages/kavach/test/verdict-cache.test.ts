import { describe, expect, it } from 'vitest';
import { VerdictCache } from '../src/verdict-cache.js';

describe('VerdictCache', () => {
  it('returns undefined on miss', () => {
    const cache = new VerdictCache<string>();
    expect(cache.get('nonexistent')).toBeUndefined();
  });

  it('returns the cached value on hit', () => {
    const cache = new VerdictCache<string>();
    cache.set('key1', 'value1');
    expect(cache.get('key1')).toBe('value1');
  });

  it('invalidates all entries when step advances', () => {
    const cache = new VerdictCache<string>();
    cache.set('key1', 'value1');
    expect(cache.get('key1')).toBe('value1');

    cache.setStep(1);
    expect(cache.get('key1')).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it('does not invalidate when step is set to the same value', () => {
    const cache = new VerdictCache<number>();
    cache.setStep(5);
    cache.set('key1', 42);
    cache.setStep(5); // same step
    expect(cache.get('key1')).toBe(42);
  });

  it('evicts LRU entry when max size is reached', () => {
    const cache = new VerdictCache<string>(3);
    cache.set('a', '1');
    cache.set('b', '2');
    cache.set('c', '3');
    // Cache is full. Adding 'd' should evict 'a' (oldest).
    cache.set('d', '4');
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe('2');
    expect(cache.get('c')).toBe('3');
    expect(cache.get('d')).toBe('4');
  });

  it('promotes recently accessed entries in LRU order', () => {
    const cache = new VerdictCache<string>(3);
    cache.set('a', '1');
    cache.set('b', '2');
    cache.set('c', '3');
    // Access 'a' to promote it.
    cache.get('a');
    // Adding 'd' should now evict 'b' (the new LRU), not 'a'.
    cache.set('d', '4');
    expect(cache.get('a')).toBe('1');
    expect(cache.get('b')).toBeUndefined();
  });

  it('has() returns true for current-step entries only', () => {
    const cache = new VerdictCache<string>();
    cache.set('key1', 'val');
    expect(cache.has('key1')).toBe(true);
    expect(cache.has('missing')).toBe(false);

    cache.setStep(1);
    expect(cache.has('key1')).toBe(false);
  });

  it('clear() drops all entries', () => {
    const cache = new VerdictCache<string>();
    cache.set('a', '1');
    cache.set('b', '2');
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.get('a')).toBeUndefined();
  });

  it('tracks hit/miss stats', () => {
    const cache = new VerdictCache<string>();
    cache.set('x', 'y');
    cache.hit();
    cache.miss();
    cache.hit();
    const s = cache.stats();
    expect(s.hits).toBe(2);
    expect(s.misses).toBe(1);
    expect(s.hitRate).toBeCloseTo(2 / 3);
    expect(s.size).toBe(1);
  });

  it('stats returns 0 hitRate when no hits or misses', () => {
    const cache = new VerdictCache<string>();
    expect(cache.stats().hitRate).toBe(0);
  });

  it('works with complex value types', () => {
    interface Detection { cls: string; confidence: number }
    const cache = new VerdictCache<Detection[]>();
    const detections = [{ cls: 'AADHAAR', confidence: 0.99 }];
    cache.set('some-hash', detections);
    expect(cache.get('some-hash')).toEqual(detections);
  });

  it('handles the default max size of 2048', () => {
    const cache = new VerdictCache<number>();
    for (let i = 0; i < 2048; i++) {
      cache.set('key' + String(i), i);
    }
    expect(cache.size).toBe(2048);
    // Adding one more should evict the first.
    cache.set('overflow', 9999);
    expect(cache.size).toBe(2048);
    expect(cache.get('key0')).toBeUndefined();
    expect(cache.get('overflow')).toBe(9999);
  });
});
