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

describe('directional relation discovery', () => {
  it('exposes new to old without reversing PREQUEL or adding an outgoing edge', () => {
    const newer = { ...anime, sourceId: '2', slug: 'new-season' };
    const old = serializeDetail({
      ...anime,
      status: 'FINISHED',
      incomingRelations: [{ kind: 'PREQUEL', position: 0, sourceAnime: newer }],
    });
    expect(old.relations).toEqual([]);
    expect(old.incomingRelations).toMatchObject([
      { kind: 'PREQUEL', anime: { id: '2' } },
    ]);
  });

  it('preserves old to new outgoing semantics', () => {
    const edge = (id: string) => ({
      kind: 'SEQUEL',
      position: 0,
      targetAnime: { ...anime, sourceId: id },
      targetSourceId: id,
      targetSlug: id,
      targetTitle: id,
      targetPosterUrl: null,
      targetYear: null,
    });
    const result = serializeDetail({
      ...anime,
      outgoingRelations: [edge('2'), edge('3')],
    });
    expect(result.relations.map((r) => [r.kind, r.anime.id])).toEqual([
      ['SEQUEL', '2'],
      ['SEQUEL', '3'],
    ]);
    expect(result.incomingRelations).toEqual([]);
  });
});

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
