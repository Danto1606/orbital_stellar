<<<<<<< fix/pulse-webhooks-timeout-retry
// packages/pulse-core/src/Watcher.ts
import { EventEmitter } from "events";
import type { NormalizedEvent } from "./index.js";

export class Watcher extends EventEmitter {
  readonly address: string;
  private _stopped: boolean = false;
  private stopHandlers: Set<() => void> = new Set();

  constructor(address: string) {
    super();
    this.address = address;
  }

  on(eventType: string, handler: (event: NormalizedEvent) => void): this {
    if (this._stopped) return this;
    return super.on(eventType, handler);
  }

  emit(eventType: string, event: NormalizedEvent): boolean {
    if (this._stopped) return false;
    return super.emit(eventType, event);
  }

  get stopped(): boolean {
    return this._stopped;
  }

  addStopHandler(handler: () => void): () => void {
    if (this._stopped) {
      handler();
      return () => {};
    }

    this.stopHandlers.add(handler);
    return () => {
      this.stopHandlers.delete(handler);
    };
  }

  stop(): void {
    if (this._stopped) return;
=======
// packages/pulse-core/src/Watcher.ts
import { EventEmitter } from "events";
import type { NormalizedEvent, WatcherNotification } from "./index.js";

export class Watcher extends EventEmitter {
  readonly address: string;
  private _stopped = false;
  private readonly onStop?: (address: string) => void;

  constructor(address: string, onStop?: (address: string) => void) {
    super();
    this.address = address;
    this.onStop = onStop;
  }

  on(eventType: "*", handler: (event: NormalizedEvent) => void): this;
  on(
    eventType: "payment.received" | "payment.sent",
    handler: (event: NormalizedEvent) => void
  ): this;
  on(
    eventType: "engine.reconnecting" | "engine.reconnected",
    handler: (event: WatcherNotification) => void
  ): this;
  on(
    eventType: string,
    handler: ((event: NormalizedEvent) => void) | ((event: WatcherNotification) => void)
  ): this {
    if (this._stopped) return this;
    return super.on(eventType, handler);
  }

  emit(eventType: "*", event: NormalizedEvent): boolean;
  emit(
    eventType: "payment.received" | "payment.sent",
    event: NormalizedEvent
  ): boolean;
  emit(
    eventType: "engine.reconnecting" | "engine.reconnected",
    event: WatcherNotification
  ): boolean;
  emit(
    eventType: string,
    event: NormalizedEvent | WatcherNotification
  ): boolean {
    if (this._stopped) return false;
    return super.emit(eventType, event);
  }

  stop(): void {
    if (this._stopped) {
      return;
    }

>>>>>>> main
    this._stopped = true;
    for (const handler of this.stopHandlers) {
      handler();
    }
    this.stopHandlers.clear();
    this.removeAllListeners();
    this.onStop?.(this.address);
  }
}
