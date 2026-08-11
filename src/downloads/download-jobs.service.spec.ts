import { hashCapabilityToken } from './download-jobs.service';

describe('download job capabilities', () => {
  it('stores a deterministic hash instead of the bearer token', () => {
    const token = 'private-capability-token';
    const hash = hashCapabilityToken(token);

    expect(hash).toHaveLength(64);
    expect(hash).not.toContain(token);
    expect(hashCapabilityToken(token)).toBe(hash);
    expect(hashCapabilityToken(`${token}-other`)).not.toBe(hash);
  });
});
