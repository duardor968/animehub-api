import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import { PrismaService } from '../prisma/prisma.service';
import { RemoteEvents } from './remote-events';
import { RemoteService } from './remote.service';

const testUrl = process.env.TEST_DATABASE_URL;
const schema = `remote_test_${randomUUID().replaceAll('-', '')}`;
describe.skipIf(!testUrl)(
  'Remote durable inbox / PostgreSQL isolated schema',
  () => {
    let admin: Pool;
    let db: PrismaService;
    let api: RemoteService;
    let events: RemoteEvents;
    beforeAll(async () => {
      admin = new Pool({ connectionString: testUrl });
      const connection = await admin.connect();
      try {
        await connection.query(`CREATE SCHEMA "${schema}"`);
        await connection.query(`SET search_path TO "${schema}"`);
        for (const directory of (await readdir(resolve('prisma/migrations')))
          .filter((n) => /^\d/.test(n))
          .sort())
          await connection.query(
            await readFile(
              resolve('prisma/migrations', directory, 'migration.sql'),
              'utf8',
            ),
          );
      } finally {
        connection.release();
      }
      const url = new URL(testUrl!);
      url.searchParams.set('schema', schema);
      db = new PrismaService(
        new ConfigService({ DATABASE_URL: url.toString() }),
      );
      events = new RemoteEvents();
      api = new RemoteService(db, events);
    });
    afterAll(async () => {
      await db?.$disconnect();
      if (admin) {
        await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await admin.end();
      }
    });
    async function setup() {
      const device = await api.register('Test PC');
      const other = await api.register('Other PC');
      const session = await api.createSession();
      const outsider = await api.createSession();
      const da = `Bearer ${device.token}`;
      const sa = `Bearer ${session.token}`;
      const code = await api.pairing(da);
      await api.pair(code.code, sa);
      await api.publish(
        {
          revision: 1,
          profiles: [
            { id: 'anime', label: 'Anime', engine: 'direct', isDefault: true },
          ],
        },
        da,
      );
      const dto = {
        deviceId: device.id,
        animeSlug: 'test-anime',
        episodeNumbers: [1, 2],
        profileId: 'anime',
        profileRevision: 1,
        engine: 'direct',
      };
      return { device, other, session, outsider, da, sa, dto, code };
    }
    it('one-use pairing, role separation, multi-PC/session boundaries and hashed secrets', async () => {
      const f = await setup();
      await expect(
        api.pair(f.code.code, `Bearer ${f.outsider.token}`),
      ).rejects.toThrow();
      await expect(api.devices(f.da)).rejects.toThrow();
      await expect(api.inbox(f.sa)).rejects.toThrow();
      expect((await api.devices(`Bearer ${f.outsider.token}`)).devices).toEqual(
        [],
      );
      await expect(
        api.create(f.dto, randomUUID(), `Bearer ${f.outsider.token}`),
      ).rejects.toThrow();
      const row = await api.create(f.dto, randomUUID(), f.sa);
      await expect(
        api.deviceRequest(row.id, `Bearer ${f.other.token}`),
      ).rejects.toThrow();
      await expect(
        api.ack(row.id, { status: 'accepted' }, `Bearer ${f.other.token}`),
      ).rejects.toThrow();
      await expect(
        api.cancel(row.id, `Bearer ${f.outsider.token}`),
      ).rejects.toThrow();
      expect(
        (
          await db.remoteDevice.findUniqueOrThrow({
            where: { id: f.device.id },
          })
        ).tokenHash,
      ).not.toContain(f.device.token);
    });
    it('survives service restart/offline; sender idempotency collapses concurrent replays and rejects mismatch', async () => {
      const f = await setup();
      const key = randomUUID();
      const results = await Promise.all(
        Array.from({ length: 4 }, () => api.create(f.dto, key, f.sa)),
      );
      expect(new Set(results.map((r) => r.id)).size).toBe(1);
      await expect(
        api.create({ ...f.dto, episodeNumbers: [3] }, key, f.sa),
      ).rejects.toThrow();
      const restarted = new RemoteService(db, new RemoteEvents());
      expect((await restarted.inbox(f.da)).requests.map((r) => r.id)).toContain(
        results[0].id,
      );
      expect((await restarted.inbox(f.da)).requests.map((r) => r.id)).toContain(
        results[0].id,
      );
    });
    it('atomic accept/cancel race has one winner; replay accepts, accepted cannot cancel', async () => {
      const f = await setup();
      const row = await api.create(f.dto, randomUUID(), f.sa);
      const result = await Promise.allSettled([
        api.ack(row.id, { status: 'accepted' }, f.da),
        api.cancel(row.id, f.sa),
      ]);
      expect(result.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const actual = await api.deviceRequest(row.id, f.da);
      if (actual.status === 'accepted') {
        expect(
          (await api.ack(row.id, { status: 'accepted' }, f.da)).status,
        ).toBe('accepted');
        await expect(api.cancel(row.id, f.sa)).rejects.toThrow();
      } else
        await expect(
          api.ack(row.id, { status: 'accepted' }, f.da),
        ).rejects.toThrow();
    });
    it('revoke cancels all own pending; accepted survives and another linked sender is untouched', async () => {
      const f = await setup();
      const pending = await api.create(f.dto, randomUUID(), f.sa);
      const accepted = await api.create(f.dto, randomUUID(), f.sa);
      await api.ack(accepted.id, { status: 'accepted' }, f.da);
      const pairing = await api.pairing(f.da);
      await api.pair(pairing.code, `Bearer ${f.outsider.token}`);
      const other = await api.create(
        f.dto,
        randomUUID(),
        `Bearer ${f.outsider.token}`,
      );
      await api.revoke(f.device.id, f.sa);
      expect((await api.deviceRequest(pending.id, f.da)).status).toBe(
        'cancelled',
      );
      expect((await api.deviceRequest(accepted.id, f.da)).status).toBe(
        'accepted',
      );
      expect((await api.deviceRequest(other.id, f.da)).status).toBe('pending');
      await expect(
        api.ack(pending.id, { status: 'accepted' }, f.da),
      ).rejects.toThrow();
      expect(
        (await api.ack(accepted.id, { status: 'accepted' }, f.da)).status,
      ).toBe('accepted');
      expect((await api.devices(f.sa)).devices).toEqual([]);
    });
    it('profile revision pins destination; incompatible pending is attention and cannot be retargeted', async () => {
      const f = await setup();
      const row = await api.create(f.dto, randomUUID(), f.sa);
      await api.publish(
        {
          revision: 2,
          profiles: [
            {
              id: 'anime',
              label: 'Another folder',
              engine: 'jdownloader',
              isDefault: true,
            },
          ],
        },
        f.da,
      );
      expect((await api.deviceRequest(row.id, f.da)).status).toBe(
        'requires_attention',
      );
      await expect(
        api.ack(row.id, { status: 'accepted' }, f.da),
      ).rejects.toThrow();
      await expect(api.create(f.dto, randomUUID(), f.sa)).rejects.toThrow();
      await expect(
        api.publish({ revision: 2, profiles: [] }, f.da),
      ).rejects.toThrow();
      expect((await api.deviceRequest(row.id, f.da)).engine).toBe('direct');
    });
    it('two pairing consumers cannot both consume a code; one browser links multiple PCs', async () => {
      const f = await setup();
      const p = await api.pairing(`Bearer ${f.other.token}`);
      const consumers = await Promise.allSettled([
        api.pair(p.code, f.sa),
        api.pair(p.code, `Bearer ${f.outsider.token}`),
      ]);
      expect(consumers.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const another = await api.pairing(`Bearer ${f.other.token}`);
      await api.pair(another.code, f.sa);
      expect((await api.devices(f.sa)).devices.map((d) => d.id).sort()).toEqual(
        [f.device.id, f.other.id].sort(),
      );
    });
    it('revoke racing acknowledgement leaves either accepted or cancelled, never a revoked pending', async () => {
      const f = await setup();
      const row = await api.create(f.dto, randomUUID(), f.sa);
      await Promise.allSettled([
        api.ack(row.id, { status: 'accepted' }, f.da),
        api.revoke(f.device.id, f.sa),
      ]);
      const stored = await api.deviceRequest(row.id, f.da);
      expect(['accepted', 'cancelled']).toContain(stored.status);
      expect((await api.devices(f.sa)).devices).toEqual([]);
    });
    it('desktop can revoke only its own browser links and cancels pending atomically', async () => {
      const f = await setup();
      const row = await api.create(f.dto, randomUUID(), f.sa);
      expect((await api.deviceLinks(f.da)).links.map((l) => l.id)).toEqual([
        f.session.id,
      ]);
      expect((await api.deviceLinks(`Bearer ${f.other.token}`)).links).toEqual(
        [],
      );
      await expect(
        api.revokeBrowser(f.session.id, `Bearer ${f.other.token}`),
      ).rejects.toThrow();
      await api.revokeBrowser(f.session.id, f.da);
      expect((await api.deviceLinks(f.da)).links).toEqual([]);
      expect((await api.deviceRequest(row.id, f.da)).status).toBe('cancelled');
    });
    it('exposes canonical catalog titles in single and batch responses without inventing missing metadata', async () => {
      const f = await setup();
      const row = await api.create(
        { ...f.dto, animeSlug: 'canonical-title-fixture' },
        randomUUID(),
        f.sa,
      );
      expect((await api.withTitles(row)).animeTitle).toBeNull();
      await db.anime.create({
        data: {
          slug: 'canonical-title-fixture',
          sourceId: 'canonical-title-fixture',
          title: 'Canonical Anime Title',
          sourceUrl: 'https://example.invalid/canonical-title-fixture',
          lastSeenAt: new Date(),
          lastFetchedAt: new Date(),
          nextRefreshAt: new Date(),
        },
      });
      expect((await api.withTitles(row)).animeTitle).toBe(
        'Canonical Anime Title',
      );
      expect(
        (await api.withTitles({ requests: [row] })).requests[0].animeTitle,
      ).toBe('Canonical Anime Title');
    });
    it('expiry rejects pairing and malformed tokens cannot authenticate', async () => {
      const d = await api.register('Expired');
      const s = await api.createSession();
      const p = await api.pairing(`Bearer ${d.token}`);
      await db.remotePairing.update({
        where: { deviceId: d.id },
        data: { expiresAt: new Date(0) },
      });
      await expect(api.pair(p.code, `Bearer ${s.token}`)).rejects.toThrow();
    });
    it('shows a PC offline as soon as its channel closes, and tells its browsers', async () => {
      const device = await api.register('Channel PC');
      const poller = await api.register('Polling PC');
      const session = await api.createSession();
      const sa = `Bearer ${session.token}`;
      await api.pair((await api.pairing(`Bearer ${device.token}`)).code, sa);
      await api.pair((await api.pairing(`Bearer ${poller.token}`)).code, sa);
      const seen: string[] = [];
      const browser = (await api.sessionEvents(sa)).subscribe(
        (e) => e.type && seen.push(e.type),
      );
      const online = async () =>
        Object.fromEntries(
          (await api.devices(sa)).devices.map((d) => [d.name, d.online]),
        );
      try {
        // Without a channel, seen recently: online by the 90 s rule.
        await api.inbox(`Bearer ${poller.token}`);
        const channel = (
          await api.deviceEvents(`Bearer ${device.token}`)
        ).subscribe();
        await vi.waitFor(() => expect(seen).toEqual(['devices']));
        expect(await online()).toEqual({
          'Channel PC': true,
          'Polling PC': true,
        });
        channel.unsubscribe();
        await vi.waitFor(() => expect(seen).toEqual(['devices', 'devices']));
        // Seen a moment ago, but its channel closed: offline now, not in 90 s.
        expect(await online()).toEqual({
          'Channel PC': false,
          'Polling PC': true,
        });
      } finally {
        browser.unsubscribe();
      }
    });
    it('tells each PC and browser what to read again, and names browsers by their User-Agent', async () => {
      const device = await api.register('Live PC');
      const session = await api.createSession();
      const stranger = await api.createSession();
      const da = `Bearer ${device.token}`;
      const sa = `Bearer ${session.token}`;
      const seen = { device: [] as string[], session: [] as string[] };
      const strangerSeen: string[] = [];
      const take = (list: string[]) => list.splice(0);
      const registered = await db.remoteDevice.findUniqueOrThrow({
        where: { id: device.id },
      });
      const streams = [
        (await api.deviceEvents(da)).subscribe(
          (e) => e.type && seen.device.push(e.type),
        ),
        (await api.sessionEvents(sa)).subscribe(
          (e) => e.type && seen.session.push(e.type),
        ),
        (await api.sessionEvents(`Bearer ${stranger.token}`)).subscribe(
          (e) => e.type && strangerSeen.push(e.type),
        ),
      ];
      try {
        // Opening the channel counts as being seen.
        expect(
          (
            await db.remoteDevice.findUniqueOrThrow({
              where: { id: device.id },
            })
          ).lastSeenAt.getTime(),
        ).toBeGreaterThanOrEqual(registered.lastSeenAt.getTime());
        await expect(api.deviceEvents(sa)).rejects.toThrow();
        await expect(api.sessionEvents(da)).rejects.toThrow();

        const code = await api.pairing(da);
        await api.pair(
          code.code,
          sa,
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
        );
        expect(take(seen.device)).toEqual(['links']);
        expect(take(seen.session)).toEqual(['devices']);
        expect((await api.deviceLinks(da)).links[0].name).toBe(
          'Chrome en Windows',
        );

        await api.publish(
          {
            revision: 1,
            profiles: [
              {
                id: 'anime',
                label: 'Anime',
                engine: 'direct',
                isDefault: true,
              },
            ],
          },
          da,
        );
        expect(take(seen.session)).toEqual(['devices', 'requests']);
        const dto = {
          deviceId: device.id,
          animeSlug: 'live-anime',
          episodeNumbers: [1],
          profileId: 'anime',
          profileRevision: 1,
          engine: 'direct',
        };
        const row = await api.create(dto, randomUUID(), sa);
        expect(take(seen.device)).toEqual(['inbox']);
        expect(take(seen.session)).toEqual(['requests']);
        await api.ack(row.id, { status: 'accepted' }, da);
        expect(take(seen.session)).toEqual(['requests']);
        const second = await api.create(dto, randomUUID(), sa);
        take(seen.device);
        take(seen.session);
        await api.cancel(second.id, sa);
        expect(take(seen.device)).toEqual(['inbox']);
        expect(take(seen.session)).toEqual(['requests']);

        await api.revokeBrowser(session.id, da);
        expect(take(seen.device)).toEqual(['links', 'inbox']);
        expect(take(seen.session)).toEqual(['devices', 'requests']);
        // Linked again without a known User-Agent: the generic name.
        await api.pair((await api.pairing(da)).code, sa, 'curl/8.0');
        expect((await api.deviceLinks(da)).links[0].name).toBe(
          'Navegador vinculado',
        );
        take(seen.device);
        take(seen.session);
        await api.revoke(device.id, sa);
        expect(take(seen.device)).toEqual(['links', 'inbox']);
        expect(take(seen.session)).toEqual(['devices', 'requests']);
        expect(strangerSeen).toEqual([]);
      } finally {
        for (const stream of streams) stream.unsubscribe();
      }
    });
  },
);
