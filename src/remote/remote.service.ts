import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { Prisma, RemoteRequest } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  AckRemoteRequestDto,
  CreateRemoteRequestDto,
  DestinationProfileDto,
  PublishProfilesDto,
} from './remote.dto';

const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');
const secret = () => randomBytes(32).toString('base64url');
const profileFingerprint = (profiles: DestinationProfileDto[]) =>
  JSON.stringify(
    profiles
      .map((p) => [p.id, p.label, p.engine, p.isDefault])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  );
type Tx = Prisma.TransactionClient;
export function remoteToken(header: string | undefined) {
  if (!header || !/^Bearer [A-Za-z0-9_-]{43}$/.test(header))
    throw new UnauthorizedException();
  return hash(header.slice(7));
}
export function publicRequest(row: RemoteRequest) {
  return {
    id: row.id,
    deviceId: row.deviceId,
    animeSlug: row.animeSlug,
    episodeNumbers: row.episodeNumbers,
    profileId: row.profileId,
    profileRevision: row.profileRevision,
    engine: row.engine,
    status: row.status,

    createdAt: row.createdAt,
    acceptedAt: row.acceptedAt,
    reason: row.reason,
  };
}
@Injectable()
export class RemoteService {
  constructor(private readonly db: PrismaService) {}
  async withTitles<T extends { animeSlug: string }>(
    value: T,
  ): Promise<T & { animeTitle: string | null }>;
  async withTitles<T extends { animeSlug: string }>(value: {
    requests: T[];
  }): Promise<{ requests: (T & { animeTitle: string | null })[] }>;
  async withTitles<T extends { animeSlug: string }>(
    value: T | { requests: T[] },
  ) {
    const rows = 'requests' in value ? value.requests : [value];
    const titles = new Map(
      (
        await this.db.anime.findMany({
          where: {
            slug: { in: [...new Set(rows.map((row) => row.animeSlug))] },
          },
          select: { slug: true, title: true },
        })
      ).map((anime) => [anime.slug, anime.title]),
    );
    const present = (row: T) => ({
      ...row,
      animeTitle: titles.get(row.animeSlug) ?? null,
    });
    return 'requests' in value
      ? { requests: rows.map(present) }
      : present(value);
  }
  private async write<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.db.$transaction(work, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });
      } catch (error) {
        if (
          attempt < 4 &&
          error instanceof Prisma.PrismaClientKnownRequestError &&
          ['P2034', 'P2002'].includes(error.code)
        )
          continue;
        throw error;
      }
    }
  }
  private async device(tx: Tx, authorization?: string) {
    const row = await tx.remoteDevice.findUnique({
      where: { tokenHash: remoteToken(authorization) },
    });
    if (!row) throw new UnauthorizedException();
    return row;
  }
  private async session(tx: Tx, authorization?: string) {
    const row = await tx.remoteSession.findUnique({
      where: { tokenHash: remoteToken(authorization) },
    });
    if (!row) throw new UnauthorizedException();
    return row;
  }
  async register(name: string) {
    const token = secret();
    const row = await this.db.remoteDevice.create({
      data: { name, tokenHash: hash(token) },
    });
    return { id: row.id, token };
  }
  async createSession() {
    const token = secret();
    const row = await this.db.remoteSession.create({
      data: { tokenHash: hash(token) },
    });
    return { id: row.id, token };
  }
  pairing(authorization?: string) {
    return this.write(async (tx) => {
      const device = await this.device(tx, authorization);
      const code = randomInt(0, 1000000).toString().padStart(6, '0');
      const expiresAt = new Date(Date.now() + 600000);
      await tx.remotePairing.upsert({
        where: { deviceId: device.id },
        create: { deviceId: device.id, codeHash: hash(code), expiresAt },
        update: { codeHash: hash(code), expiresAt },
      });
      return { code, expiresAt };
    });
  }
  pair(code: string, authorization?: string) {
    return this.write(async (tx) => {
      const session = await this.session(tx, authorization);
      const pairing = await tx.remotePairing.findUnique({
        where: { codeHash: hash(code) },
      });
      if (!pairing || pairing.expiresAt <= new Date())
        throw new NotFoundException('Pairing code unavailable');
      await tx.remotePairing.delete({ where: { deviceId: pairing.deviceId } });
      await tx.remoteLink.upsert({
        where: {
          sessionId_deviceId: {
            sessionId: session.id,
            deviceId: pairing.deviceId,
          },
        },
        create: { sessionId: session.id, deviceId: pairing.deviceId },
        update: { revokedAt: null },
      });
      return { deviceId: pairing.deviceId };
    });
  }
  async devices(authorization?: string) {
    const session = await this.session(this.db, authorization);
    const links = await this.db.remoteLink.findMany({
      where: { sessionId: session.id, revokedAt: null },
      include: { device: true },
      orderBy: { createdAt: 'asc' },
    });
    return {
      devices: links.map(({ device: d }) => ({
        id: d.id,
        name: d.name,
        profileRevision: d.profileRevision,
        profiles: d.profiles,
        lastSeenAt: d.lastSeenAt,
      })),
    };
  }
  publish(dto: PublishProfilesDto, authorization?: string) {
    if (
      new Set(dto.profiles.map((p) => p.id)).size !== dto.profiles.length ||
      dto.profiles.filter((p) => p.isDefault).length > 1
    )
      throw new BadRequestException('Duplicate profile or default');
    return this.write(async (tx) => {
      const device = await this.device(tx, authorization);
      if (
        dto.revision < device.profileRevision ||
        (dto.revision === device.profileRevision &&
          profileFingerprint(dto.profiles) !==
            profileFingerprint(
              device.profiles as unknown as DestinationProfileDto[],
            ))
      )
        throw new ConflictException('Profile revision must increase');
      await tx.remoteDevice.update({
        where: { id: device.id },
        data: {
          profiles: JSON.parse(
            JSON.stringify(dto.profiles),
          ) as Prisma.InputJsonValue,
          profileRevision: dto.revision,
          lastSeenAt: new Date(),
        },
      });
      if (dto.revision !== device.profileRevision)
        await tx.remoteRequest.updateMany({
          where: {
            deviceId: device.id,
            status: 'pending',
            profileRevision: { not: dto.revision },
          },
          data: {
            status: 'requires_attention',
            reason: 'Destination profile changed',
          },
        });
      return { revision: dto.revision };
    });
  }
  create(
    dto: CreateRemoteRequestDto,
    key: string | undefined,
    authorization?: string,
  ) {
    if (
      !key ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        key,
      )
    )
      throw new BadRequestException('Idempotency-Key must be a UUID');
    const normalized = {
      ...dto,
      episodeNumbers: [...dto.episodeNumbers].sort((a, b) => a - b),
    };
    const fingerprint = hash(
      JSON.stringify([
        dto.deviceId,
        dto.animeSlug,
        normalized.episodeNumbers,
        dto.profileId,
        dto.profileRevision,
        dto.engine,
      ]),
    );
    return this.write(async (tx) => {
      const session = await this.session(tx, authorization);
      const link = await tx.remoteLink.findUnique({
        where: {
          sessionId_deviceId: { sessionId: session.id, deviceId: dto.deviceId },
        },
        include: { device: true },
      });
      if (!link || link.revokedAt) throw new NotFoundException();
      const previous = await tx.remoteRequest.findUnique({
        where: {
          sessionId_idempotencyKey: {
            sessionId: session.id,
            idempotencyKey: key,
          },
        },
      });
      if (previous) {
        if (previous.fingerprint !== fingerprint)
          throw new ConflictException(
            'Idempotency key reused with another request',
          );
        return publicRequest(previous);
      }
      const profiles = link.device
        .profiles as unknown as DestinationProfileDto[];
      if (
        link.device.profileRevision !== dto.profileRevision ||
        !profiles.some((p) => p.id === dto.profileId && p.engine === dto.engine)
      )
        throw new ConflictException('Destination profile changed');
      const row = await tx.remoteRequest.create({
        data: {
          ...normalized,
          sessionId: session.id,
          idempotencyKey: key,
          fingerprint,
        },
      });
      return publicRequest(row);
    });
  }
  async requests(authorization?: string) {
    const session = await this.session(this.db, authorization);
    return {
      requests: (
        await this.db.remoteRequest.findMany({
          where: { sessionId: session.id },
          orderBy: { createdAt: 'desc' },
          take: 200,
        })
      ).map(publicRequest),
    };
  }
  inbox(authorization?: string) {
    return this.write(async (tx) => {
      const device = await this.device(tx, authorization);
      await tx.remoteDevice.update({
        where: { id: device.id },
        data: { lastSeenAt: new Date() },
      });
      await this.reconcile(tx, device.id);
      return {
        requests: (
          await tx.remoteRequest.findMany({
            where: { deviceId: device.id, status: 'pending' },
            orderBy: { createdAt: 'asc' },
            take: 100,
          })
        ).map(publicRequest),
      };
    });
  }
  private async reconcile(tx: Tx, deviceId: string) {
    const revoked = await tx.remoteLink.findMany({
      where: { deviceId, revokedAt: { not: null } },
      select: { sessionId: true },
    });
    await tx.remoteRequest.updateMany({
      where: {
        deviceId,
        status: 'pending',
        sessionId: { in: revoked.map((l) => l.sessionId) },
      },
      data: { status: 'cancelled' },
    });
  }
  async deviceRequest(id: string, authorization?: string) {
    const device = await this.device(this.db, authorization);
    const row = await this.db.remoteRequest.findFirst({
      where: { id, deviceId: device.id },
    });
    if (!row) throw new NotFoundException();
    return publicRequest(row);
  }
  ack(id: string, dto: AckRemoteRequestDto, authorization?: string) {
    return this.write(async (tx) => {
      const device = await this.device(tx, authorization);
      const row = await tx.remoteRequest.findFirst({
        where: { id, deviceId: device.id },
      });
      if (!row) throw new NotFoundException();

      if (row.status === dto.status) return publicRequest(row);
      const link = await tx.remoteLink.findUnique({
        where: {
          sessionId_deviceId: { sessionId: row.sessionId, deviceId: device.id },
        },
      });
      if (row.status !== 'pending' || !link || link.revokedAt)
        throw new ConflictException('Request cancelled or link revoked');
      if (
        dto.status === 'accepted' &&
        row.profileRevision !== device.profileRevision
      )
        throw new ConflictException('Destination profile changed');
      return publicRequest(
        await tx.remoteRequest.update({
          where: { id },
          data: {
            status: dto.status,
            reason:
              dto.status === 'requires_attention'
                ? (dto.reason ?? 'Desktop requires attention')
                : null,
            acceptedAt: dto.status === 'accepted' ? new Date() : null,
          },
        }),
      );
    });
  }
  cancel(id: string, authorization?: string) {
    return this.write(async (tx) => {
      const session = await this.session(tx, authorization);
      const row = await tx.remoteRequest.findFirst({
        where: { id, sessionId: session.id },
      });
      if (!row) throw new NotFoundException();
      if (row.status === 'cancelled') return publicRequest(row);
      if (row.status !== 'pending')
        throw new ConflictException(
          'Request already delivered or being delivered',
        );
      return publicRequest(
        await tx.remoteRequest.update({
          where: { id },
          data: { status: 'cancelled' },
        }),
      );
    });
  }
  async deviceLinks(authorization?: string) {
    const device = await this.device(this.db, authorization);
    const links = await this.db.remoteLink.findMany({
      where: { deviceId: device.id, revokedAt: null },
      orderBy: { createdAt: 'asc' },
    });
    return {
      links: links.map((link) => ({
        id: link.sessionId,
        name: 'Navegador vinculado',
        createdAt: link.createdAt,
      })),
    };
  }
  revokeBrowser(sessionId: string, authorization?: string) {
    return this.write(async (tx) => {
      const device = await this.device(tx, authorization);
      const link = await tx.remoteLink.findUnique({
        where: { sessionId_deviceId: { sessionId, deviceId: device.id } },
      });
      if (!link) throw new NotFoundException();
      await tx.remoteLink.update({
        where: { sessionId_deviceId: { sessionId, deviceId: device.id } },
        data: { revokedAt: new Date() },
      });
      await this.reconcile(tx, device.id);
      return { id: sessionId, revoked: true };
    });
  }
  revoke(deviceId: string, authorization?: string) {
    return this.write(async (tx) => {
      const session = await this.session(tx, authorization);
      const link = await tx.remoteLink.findUnique({
        where: { sessionId_deviceId: { sessionId: session.id, deviceId } },
      });
      if (!link) throw new NotFoundException();
      await tx.remoteLink.update({
        where: { sessionId_deviceId: { sessionId: session.id, deviceId } },
        data: { revokedAt: new Date() },
      });
      await this.reconcile(tx, deviceId);
      return { deviceId, revoked: true };
    });
  }
}
