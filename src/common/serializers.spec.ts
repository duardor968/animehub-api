import { serializeDetail, serializeFeatured, sortByName } from './serializers';

const genre = (name: string) => ({
  genre: { sourceId: name, name, slug: name.toLowerCase() },
});

const anime = {
  sourceId: '1',
  slug: 'one-piece',
  title: 'One Piece',
  synopsis: null,
  posterUrl: null,
  backdropUrl: null,
  status: 'AIRING',
  category: null,
  startDate: null,
  mature: false,
  genres: [
    genre('Shounen'),
    genre('Comedia'),
    genre('Aventura'),
    genre('Fantasía'),
    genre('Acción'),
    genre('Drama'),
  ],
};

describe('genre serialization', () => {
  const expected = [
    'Acción',
    'Aventura',
    'Comedia',
    'Drama',
    'Fantasía',
    'Shounen',
  ];

  it('always returns an anime genres sorted by name', () => {
    expect(serializeDetail(anime).genres.map((g) => g.name)).toEqual(expected);
    expect(serializeFeatured(anime).genres.map((g) => g.name)).toEqual(
      expected,
    );
  });

  it('sorts accented names with Spanish collation and does not mutate input', () => {
    const input = [{ name: 'Ñoño' }, { name: 'Zombis' }, { name: 'Niños' }];
    expect(sortByName(input).map((item) => item.name)).toEqual([
      'Niños',
      'Ñoño',
      'Zombis',
    ]);
    expect(input[0].name).toBe('Ñoño');
  });
});
