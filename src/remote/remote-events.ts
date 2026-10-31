import { Injectable, MessageEvent, OnModuleDestroy } from '@nestjs/common';
import {
  EMPTY,
  Observable,
  Subject,
  defer,
  filter,
  finalize,
  interval,
  map,
  merge,
  takeUntil,
} from 'rxjs';

/** What changed for the PC: its pending requests or the browsers linked to it. */
export type DeviceEvent = 'inbox' | 'links';
/** What changed for a browser: its linked PCs or the requests it sent. */
export type SessionEvent = 'devices' | 'requests';

// Cloudflare closes a proxied response after 125 s without a byte; Traefik and
// the clients' own watchdogs need less. A comment every 25 s keeps it open.
export const HEARTBEAT_MS = 25000;

type Change =
  | { audience: 'device'; id: string; type: DeviceEvent }
  | { audience: 'session'; id: string; type: SessionEvent };

/**
 * Live channel of the remote module, inside this process: each event only says
 * what to read again, and every client reads its state again when it
 * (re)connects, so nothing is lost while a connection is down.
 */
@Injectable()
export class RemoteEvents implements OnModuleDestroy {
  private readonly changes = new Subject<Change>();
  private readonly closing = new Subject<void>();
  // The PCs with a channel open here, and those whose last one closed here.
  private readonly connected = new Map<string, number>();
  private readonly gone = new Set<string>();
  private shuttingDown = false;

  /** The PC's channel is open (true), closed (false), or never seen here (null). */
  presence(id: string): boolean | null {
    return this.connected.has(id) ? true : this.gone.has(id) ? false : null;
  }
  /** A PC's channel: `changed` runs once it counts as open, and when its last
   *  open channel closes (not on shutdown). */
  deviceStream(
    id: string,
    alongside: Observable<never>,
    changed: () => void,
  ): Observable<MessageEvent> {
    return defer(() => {
      this.connected.set(id, (this.connected.get(id) ?? 0) + 1);
      this.gone.delete(id);
      changed();
      return this.stream('device', id, alongside);
    }).pipe(
      finalize(() => {
        const left = (this.connected.get(id) ?? 1) - 1;
        if (left > 0) {
          this.connected.set(id, left);
          return;
        }
        this.connected.delete(id);
        this.gone.add(id);
        if (!this.shuttingDown) changed();
      }),
    );
  }

  device(id: string, ...types: DeviceEvent[]) {
    for (const type of new Set(types))
      this.changes.next({ audience: 'device', id, type });
  }
  session(id: string, ...types: SessionEvent[]) {
    for (const type of new Set(types))
      this.changes.next({ audience: 'session', id, type });
  }
  /** `alongside`: work tied to the connection; it ends with it. */
  stream(
    audience: Change['audience'],
    id: string,
    alongside: Observable<never> = EMPTY,
  ): Observable<MessageEvent> {
    return merge(
      alongside,
      this.changes.pipe(
        filter((change) => change.audience === audience && change.id === id),
        map((change): MessageEvent => ({ type: change.type, data: {} })),
      ),
      interval(HEARTBEAT_MS).pipe(map((): MessageEvent => ({ comment: '' }))),
    ).pipe(takeUntil(this.closing));
  }
  // Open streams would hold the HTTP server's close; clients reconnect.
  onModuleDestroy() {
    this.shuttingDown = true;
    this.closing.next();
    this.closing.complete();
  }
}
