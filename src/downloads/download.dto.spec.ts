import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateDownloadJobDto, MAX_JOB_EPISODE_NUMBERS } from './download.dto';

const base = { audio: 'SUB', providers: ['MEGA'] };

async function messages(body: Record<string, unknown>) {
  const errors = await validate(
    plainToInstance(CreateDownloadJobDto, { ...base, ...body }),
    { whitelist: true, forbidNonWhitelisted: true },
  );
  return errors.flatMap((error) => Object.values(error.constraints ?? {}));
}

describe('CreateDownloadJobDto', () => {
  it.each([
    { scope: 'ALL' },
    // Older clients send the selected bounds along with ALL; they are ignored.
    { scope: 'ALL', from: 1, to: 12 },
    { scope: 'RANGE', from: 0, to: 0 },
    { scope: 'RANGE', from: 1, to: 1180 },
    { scope: 'EPISODES', episodeNumbers: [3, 1, 2] },
    { scope: 'EPISODES', episodeNumbers: [0] },
    { scope: 'EPISODES', episodeNumbers: [12, 12.5] },
    {
      scope: 'EPISODES',
      episodeNumbers: Array.from(
        { length: MAX_JOB_EPISODE_NUMBERS },
        (_, i) => i,
      ),
    },
  ])('accepts %j', async (body) => {
    await expect(messages(body)).resolves.toEqual([]);
  });

  it.each([
    [{ scope: 'RANGE' }, 'RANGE requires both from and to.'],
    [{ scope: 'RANGE', from: 3 }, 'RANGE requires both from and to.'],
    [{ scope: 'RANGE', to: 3 }, 'RANGE requires both from and to.'],
    [{ scope: 'RANGE', from: null, to: 3 }, 'RANGE requires both from and to.'],
    [
      { scope: 'RANGE', from: 10, to: 5 },
      'from must be less than or equal to to.',
    ],
    [
      { scope: 'RANGE', from: 1, to: 2, episodeNumbers: [1] },
      'episodeNumbers is only allowed when scope is EPISODES.',
    ],
    [{ scope: 'EPISODES' }, 'EPISODES requires episodeNumbers.'],
    [
      { scope: 'EPISODES', episodeNumbers: [1], from: 1 },
      'from and to are only allowed when scope is RANGE.',
    ],
    [
      { scope: 'ALL', episodeNumbers: [1] },
      'episodeNumbers is only allowed when scope is EPISODES.',
    ],
  ])('rejects %j', async (body, expected) => {
    await expect(messages(body)).resolves.toContain(expected);
  });

  it.each([
    [[]],
    [Array.from({ length: MAX_JOB_EPISODE_NUMBERS + 1 }, (_, i) => i)],
    [[1, 2, 2]],
    [[0, -0]],
    [[-1]],
    [[Number.NaN]],
    [[Number.POSITIVE_INFINITY]],
    [['1']],
    [[null]],
    ['1,2'],
  ])('rejects invalid episodeNumbers %#', async (episodeNumbers) => {
    const errors = await messages({ scope: 'EPISODES', episodeNumbers });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects unknown scopes', async () => {
    await expect(messages({ scope: 'SERIES' })).resolves.toContain(
      'scope must be one of the following values: ALL, RANGE, EPISODES',
    );
  });
});
