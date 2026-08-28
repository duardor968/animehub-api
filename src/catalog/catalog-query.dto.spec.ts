import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CatalogQueryDto } from './catalog-query.dto';

describe('CatalogQueryDto', () => {
  it.each(['score', 'popular', 'title', 'latest_added', 'latest_released'])(
    'accepts the source-backed order %s',
    async (order) => {
      const dto = plainToInstance(CatalogQueryDto, { order });

      await expect(validate(dto)).resolves.toHaveLength(0);
    },
  );

  it.each(['title-asc', 'title-desc', 'score-desc', 'date-desc', 'unknown'])(
    'rejects the unsupported order %s',
    async (order) => {
      const dto = plainToInstance(CatalogQueryDto, { order });
      const errors = await validate(dto);
      const orderError = errors.find((error) => error.property === 'order');

      expect(orderError?.constraints?.isIn).toEqual(expect.any(String));
    },
  );

  it('rejects status values the source does not support', async () => {
    const dto = plainToInstance(CatalogQueryDto, { status: 'watched' });
    const errors = await validate(dto);

    expect(errors.some((error) => error.property === 'status')).toBe(true);
  });

  it('bounds repeated taxonomy filters', async () => {
    const dto = plainToInstance(CatalogQueryDto, {
      genre: Array.from({ length: 21 }, (_, index) => `genre-${index}`),
    });
    const errors = await validate(dto);

    expect(errors.some((error) => error.property === 'genre')).toBe(true);
  });
});
