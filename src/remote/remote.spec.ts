import { describe, it, expect } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateRemoteRequestDto, PublishProfilesDto } from './remote.dto';
import { remoteToken } from './remote.service';

describe('Remote boundary validation', () => {
  it('requires an opaque bearer and hashes it before lookup', () => {
    expect(() => remoteToken(undefined)).toThrow();
    expect(() => remoteToken('Bearer abc')).toThrow();
    expect(remoteToken(`Bearer ${'a'.repeat(43)}`)).toMatch(/^[a-f0-9]{64}$/);
  });
  it('rejects paths, signed URLs, unknown keys, duplicate episodes and source-supplied provider settings', async () => {
    const good = {
      deviceId: '7885d03f-f1cd-469d-bd65-591c53186cb3',
      animeSlug: 'anime-one',
      episodeNumbers: [1, 2.5],
      profileId: 'default',
      profileRevision: 1,
      engine: 'direct',
    };
    const check = (dto: object) =>
      validate(plainToInstance(CreateRemoteRequestDto, dto), {
        whitelist: true,
        forbidNonWhitelisted: true,
      });
    expect(await check(good)).toEqual([]);
    expect(
      await check({
        ...good,
        episodeNumbers: Array.from({ length: 1100 }, (_, i) => i + 1),
      }),
    ).toEqual([]);
    for (const changed of [
      { path: 'C:\\Anime' },
      { signedUrl: 'https://example.invalid/?secret=private' },
      { providers: ['MEGA'] },
      { episodeNumbers: [1, 1] },
      { animeSlug: '../etc' },
      { engine: 'evil' },
    ])
      expect((await check({ ...good, ...changed })).length).toBeGreaterThan(0);
  });
  it('profile publication exposes labels and identifiers, never local paths', async () => {
    const dto = plainToInstance(PublishProfilesDto, {
      revision: 1,
      profiles: [
        {
          id: 'default',
          label: 'Anime',
          engine: 'direct',
          isDefault: true,
          path: 'C:\\Anime',
        },
      ],
    });
    expect(
      (await validate(dto, { whitelist: true, forbidNonWhitelisted: true }))
        .length,
    ).toBeGreaterThan(0);
  });
});
