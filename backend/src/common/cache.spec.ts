import { TtlCache } from './cache';

describe('TtlCache', () => {
  const prev = process.env.FORCE_CACHE;
  beforeAll(() => { process.env.FORCE_CACHE = '1'; });
  afterAll(() => { if (prev === undefined) delete process.env.FORCE_CACHE; else process.env.FORCE_CACHE = prev; });

  it('serves repeat reads from memory until the time limit passes', async () => {
    let t = 0;
    const c = new TtlCache<number>(1000, () => t);
    const load = jest.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(2);
    expect(await c.get('k', load)).toBe(1);
    t = 999;
    expect(await c.get('k', load)).toBe(1);
    expect(load).toHaveBeenCalledTimes(1);
    t = 1001;
    expect(await c.get('k', load)).toBe(2);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('shares one load between simultaneous callers and does not cache failures', async () => {
    const c = new TtlCache<string>(1000);
    let calls = 0;
    const slow = () => new Promise<string>((r) => { calls++; setTimeout(() => r('v'), 10); });
    expect(await Promise.all([c.get('k', slow), c.get('k', slow), c.get('k', slow)])).toEqual(['v', 'v', 'v']);
    expect(calls).toBe(1);
    const failing = jest.fn().mockRejectedValueOnce(new Error('db down')).mockResolvedValueOnce('ok');
    await expect(c.get('f', failing)).rejects.toThrow('db down');
    expect(await c.get('f', failing)).toBe('ok');
  });

  it('clear and delete force a fresh read', async () => {
    const c = new TtlCache<number>(1000);
    const load = jest.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(2).mockResolvedValueOnce(3);
    await c.get('a', load);
    c.delete('a');
    expect(await c.get('a', load)).toBe(2);
    c.clear();
    expect(await c.get('a', load)).toBe(3);
  });

  it('is switched off under Jest unless a test opts in, so integration tests always see the database', async () => {
    delete process.env.FORCE_CACHE;
    const c = new TtlCache<number>(1000);
    const load = jest.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(2);
    await c.get('k', load);
    expect(await c.get('k', load)).toBe(2);
    process.env.FORCE_CACHE = '1';
  });
});
