import {
  linkTtlMinutes,
  selectDownloadLinks,
} from './download-resolver.service';
import { ProviderDto, RequestedAudioDto } from './download.dto';

describe('download resolution policies', () => {
  const now = Date.UTC(2026, 7, 10, 12);

  it('uses the requested audio when available and otherwise falls back', () => {
    const links = [
      { audio: 'SUB', provider: 'MEGA', url: 'sub' },
      { audio: 'DUB', provider: 'PIXELDRAIN', url: 'dub' },
    ];

    expect(
      selectDownloadLinks(links, RequestedAudioDto.SUB, [ProviderDto.MEGA]),
    ).toEqual([links[0]]);
    expect(
      selectDownloadLinks(links, RequestedAudioDto.SUB, [
        ProviderDto.PIXELDRAIN,
      ]),
    ).toEqual([links[1]]);
    expect(
      selectDownloadLinks(links, RequestedAudioDto.SUB, [
        ProviderDto.MP4UPLOAD,
      ]),
    ).toEqual([]);
  });

  it('applies age-based and negative-cache TTLs', () => {
    expect(linkTtlMinutes(null, true, now)).toBe(2);
    expect(linkTtlMinutes(null, false, now)).toBe(15);
    expect(linkTtlMinutes(new Date(now - 24 * 60 * 60_000), false, now)).toBe(
      15,
    );
    expect(
      linkTtlMinutes(new Date(now - 5 * 24 * 60 * 60_000), false, now),
    ).toBe(60);
    expect(
      linkTtlMinutes(new Date(now - 8 * 24 * 60 * 60_000), false, now),
    ).toBe(24 * 60);
  });
});
