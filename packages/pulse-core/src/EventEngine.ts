import { Horizon } from "@stellar/stellar-sdk";
import { Watcher } from "./Watcher.js";
import type {
  AccountOptionsChanges,
  AccountOptionsEvent,
  AccountOptionsEventType,
  CoreConfig,
  Network,
  NormalizedEvent,
  PaymentEvent,
  PaymentEventType,
  ReconnectConfig,
  TrustlineEvent,
  TrustlineEventType,
  WatcherNotification,
  WatcherNotificationType,
} from "./index.js";

type PendingPaymentEvent = Omit<PaymentEvent, "type"> & { type: "unknown" };
type NormalizedEventOrPending = PendingPaymentEvent | AccountOptionsEvent | TrustlineEvent;

type StreamCallbacks = {
  onmessage: (record: unknown) => void;
  onerror: (error: unknown) => void;
};

type HorizonStreamStopper = ReturnType<
  ReturnType<Horizon.Server["payments"]>["stream"]
>;

const HORIZON_URLS: Record<Network, string> = {
  mainnet: "https://horizon.stellar.org",
  testnet: "https://horizon-testnet.stellar.org",
};

const DEFAULT_RECONNECT: Required<ReconnectConfig> = {
  initialDelayMs: 1000,
  maxDelayMs: 30000,
  maxRetries: Number.POSITIVE_INFINITY,
};

const noop = { info: () => {}, warn: () => {}, error: () => {} };

export class EventEngine {
  private server: Horizon.Server;
  private registry: Map<string, Watcher> = new Map();
  private stopStream: HorizonStreamStopper | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private pendingReconnectSuccessAttempt: number | null = null;
  private readonly reconnectConfig: Required<ReconnectConfig>;
  private isRunning = false;
  private log: Required<NonNullable<CoreConfig["logger"]>>;

  /**
   * Creates a new EventEngine instance.
   * @param config - The core configuration for the engine.
   */
  constructor(config: CoreConfig) {
    this.server = new Horizon.Server(HORIZON_URLS[config.network]);
    this.reconnectConfig = {
      ...DEFAULT_RECONNECT,
      ...config.reconnect,
    };
    this.log = config.logger ?? noop;
  }

  /**
   * Subscribes to events for a given Stellar address.
   * Returns an existing Watcher if one already exists for the address.
   * @param address - The Stellar address to watch.
   * @returns The Watcher instance for the address.
   */
  subscribe(address: string): Watcher {
    const existingWatcher = this.registry.get(address);
    if (existingWatcher) {
      return existingWatcher;
    }

    const watcher = new Watcher(address);
    watcher.addStopHandler(() => {
      this.registry.delete(address);
    });
    this.registry.set(address, watcher);
    return watcher;
  }

  /**
   * Unsubscribes from events for a given Stellar address and stops its watcher.
   * @param address - The Stellar address to stop watching.
   */
  unsubscribe(address: string): void {
    this.registry.get(address)?.stop();
  }

  /**
   * Starts the SSE stream to listen for Stellar network events.
   * No-op if the stream is already running.
   */
  start(): void {
    if (this.isRunning || this.reconnectTimer) {
      this.log.warn("[pulse-core] EventEngine.start() called while the SSE stream is already active.");
      return;
    }

    this.openStream(false);
  }

  /**
   * Stops the SSE stream and all active watchers.
   * Cleans up all resources and resets reconnection state.
   */
  stop(): void {
    this.clearReconnectTimer();
    this.pendingReconnectSuccessAttempt = null;
    this.reconnectAttempt = 0;
    this.closeStream();
    this.isRunning = false;

    for (const watcher of this.registry.values()) {
      watcher.stop();
    }
  }

  private openStream(isReconnect: boolean): void {
    this.closeStream();
    this.clearReconnectTimer();
    this.isRunning = true;
    this.pendingReconnectSuccessAttempt = isReconnect
      ? this.reconnectAttempt
      : null;

    const callbacks: StreamCallbacks = {
      onmessage: (record) => {
        if (this.pendingReconnectSuccessAttempt !== null) {
          const attempt = this.pendingReconnectSuccessAttempt;
          this.pendingReconnectSuccessAttempt = null;
          this.reconnectAttempt = 0;
          this.log.info(`[pulse-core] SSE reconnect succeeded on attempt ${attempt}.`);
          this.notifyWatchers("engine.reconnected", {
            type: "engine.reconnected",
            attempt,
            timestamp: new Date().toISOString(),
          });
        }

        const event = this.normalize(record);
        if (!event) {
          return;
        }

        this.route(event);
      },
      onerror: (error) => {
        this.log.error(`[pulse-core] SSE error: ${error}`);
        this.handleStreamError();
      },
    };

    this.stopStream = this.server
      .operations()
      .cursor("now")
      .stream(callbacks);
  }

  private handleStreamError(): void {
    if (this.reconnectTimer) {
      return;
    }

    this.closeStream();
    this.isRunning = false;
    this.pendingReconnectSuccessAttempt = null;

    const nextAttempt = this.reconnectAttempt + 1;
    if (nextAttempt > this.reconnectConfig.maxRetries) {
      this.log.error(`[pulse-core] SSE reconnect stopped after ${this.reconnectAttempt} failed attempts.`);
      return;
    }

    this.reconnectAttempt = nextAttempt;

    const delayMs = Math.min(
      this.reconnectConfig.initialDelayMs * 2 ** (nextAttempt - 1),
      this.reconnectConfig.maxDelayMs
    );

    this.log.warn(`[pulse-core] SSE reconnect attempt ${nextAttempt} scheduled in ${delayMs}ms.`);
    this.notifyWatchers("engine.reconnecting", {
      type: "engine.reconnecting",
      attempt: nextAttempt,
      delayMs,
      timestamp: new Date().toISOString(),
    });

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openStream(true);
    }, delayMs);
  }

  private closeStream(): void {
    if (!this.stopStream) {
      return;
    }

    const stopStream = this.stopStream;
    this.stopStream = null;
    stopStream();
  }

  private clearReconnectTimer(): void {
    if (!this.reconnectTimer) {
      return;
    }

    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private notifyWatchers(
    eventType: WatcherNotificationType,
    event: WatcherNotification
  ): void {
    for (const watcher of this.registry.values()) {
      watcher.emit(eventType, event);
    }
  }

  private normalize(record: unknown): NormalizedEventOrPending | null {
    const r = record as Record<string, unknown>;

    if (r.type === "payment") {
      const requiredFields = ["to", "from", "amount", "created_at"] as const;
      for (const field of requiredFields) {
        if (typeof r[field] !== "string" || r[field] === "") {
          this.log.warn(`[pulse-core] normalize() dropping payment record: field "${field}" is missing or not a non-empty string.`);
          return null;
        }
      }

      const asset =
        r.asset_type === "native"
          ? "XLM"
          : `${r.asset_code}:${r.asset_issuer}`;

      return {
        // Route resolution assigns the payment direction after normalization.
        type: "unknown",
        to: r.to as string,
        from: r.from as string,
        amount: r.amount as string,
        asset,
        timestamp: r.created_at as string,
        raw: record,
      };
    }

    if (r.type === "set_options") {
      return this.normalizeSetOptions(r, record);
    }

    if (r.type === "allow_trust") {
      return this.normalizeAllowTrust(r, record);
    }

    if (r.type === "set_trust_line_flags") {
      return this.normalizeSetTrustLineFlags(r, record);
    }

    return null;
  }

  private normalizeSetOptions(
    r: Record<string, unknown>,
    raw: unknown
  ): AccountOptionsEvent | null {
    const changes: AccountOptionsChanges = {};

    if (typeof r.signer_key === "string") {
      const weight = typeof r.signer_weight === "number" ? r.signer_weight : 0;
      if (weight === 0) {
        changes.signer_removed = { key: r.signer_key, weight: 0 };
      } else {
        changes.signer_added = { key: r.signer_key, weight };
      }
    }

    const thresholds: NonNullable<AccountOptionsChanges["thresholds"]> = {};
    if (typeof r.low_threshold === "number")
      thresholds.low_threshold = r.low_threshold;
    if (typeof r.med_threshold === "number")
      thresholds.med_threshold = r.med_threshold;
    if (typeof r.high_threshold === "number")
      thresholds.high_threshold = r.high_threshold;
    if (typeof r.master_key_weight === "number")
      thresholds.master_key_weight = r.master_key_weight;
    if (Object.keys(thresholds).length > 0) changes.thresholds = thresholds;

    if (typeof r.home_domain === "string") {
      changes.home_domain = r.home_domain;
    }

    // Known gap: set_flags, clear_flags, and inflation_dest are not tracked in `changes`.
    // Operations that only modify those fields are intentionally dropped here as no-ops.
    // TODO: track flag/inflation changes in a follow-up (see issue #XX).
    if (Object.keys(changes).length === 0) return null;

    return {
      type: "account.options_changed",
      source: r.source_account as string,
      changes,
      timestamp: r.created_at as string,
      raw,
    };
  }

  private normalizeAllowTrust(
    r: Record<string, unknown>,
    raw: unknown
  ): TrustlineEvent | null {
    const trustor = r.trustor;
    const trustee = r.trustee ?? r.source_account;
    const authorize = r.authorize;

    if (typeof trustor !== "string" || trustor === "") return null;
    if (typeof trustee !== "string" || trustee === "") return null;
    if (typeof authorize !== "boolean") return null;

    const asset = this.buildAsset(r);
    const type: TrustlineEventType = authorize ? "trustline.authorized" : "trustline.deauthorized";

    return {
      type,
      trustor,
      issuer: trustee as string,
      asset,
      timestamp: r.created_at as string,
      operation: "allow_trust",
      raw,
    };
  }

  private normalizeSetTrustLineFlags(
    r: Record<string, unknown>,
    raw: unknown
  ): TrustlineEvent | null {
    const trustor = r.trustor;
    const source = r.source_account;

    if (typeof trustor !== "string" || trustor === "") return null;
    if (typeof source !== "string" || source === "") return null;

    const asset = this.buildAsset(r);
    const type = this.resolveTrustlineType(r);
    if (type === null) return null;

    return {
      type,
      trustor,
      issuer: source as string,
      asset,
      timestamp: r.created_at as string,
      operation: "set_trust_line_flags",
      raw,
    };
  }

  private buildAsset(r: Record<string, unknown>): string {
    if (r.asset_type === "native") return "XLM";
    const code = r.asset_code ?? "";
    const issuer = r.asset_issuer ?? "";
    return `${code}:${issuer}`;
  }

  private resolveTrustlineType(r: Record<string, unknown>): TrustlineEventType | null {
    const setFlagsS = r.set_flags_s as string[] | undefined;
    const clearFlagsS = r.clear_flags_s as string[] | undefined;

    const isSettingAuth = setFlagsS?.includes("authorized");
    const isClearingAuth = clearFlagsS?.includes("authorized");

    if (isSettingAuth && !isClearingAuth) return "trustline.authorized";
    if (isClearingAuth && !isSettingAuth) return "trustline.deauthorized";
    if (isSettingAuth && isClearingAuth) return null;

    return null;
  }

  private route(event: NormalizedEventOrPending): void {
    if (event.type === "account.options_changed") {
      const watcher = this.registry.get(event.source);
      if (watcher) {
        watcher.emit("account.options_changed", event);
        watcher.emit("*", event);
      }
      return;
    }

    if (event.type === "trustline.authorized" || event.type === "trustline.deauthorized") {
      const issuerWatcher = this.registry.get(event.issuer);
      if (issuerWatcher) {
        issuerWatcher.emit(event.type, event);
        issuerWatcher.emit("*", event);
      }

      const trustorWatcher = this.registry.get(event.trustor);
      if (trustorWatcher) {
        trustorWatcher.emit(event.type, event);
        trustorWatcher.emit("*", event);
      }
      return;
    }

    const payment = event as PendingPaymentEvent;

    const toWatcher = this.registry.get(payment.to);
    if (toWatcher) {
      toWatcher.emit(
        "payment.received",
        this.withResolvedType(payment, "payment.received")
      );
      toWatcher.emit("*", this.withResolvedType(payment, "payment.received"));
    }

    const fromWatcher = this.registry.get(payment.from);
    if (fromWatcher) {
      fromWatcher.emit(
        "payment.sent",
        this.withResolvedType(payment, "payment.sent")
      );
      fromWatcher.emit("*", this.withResolvedType(payment, "payment.sent"));
    }
  }

  private withResolvedType(
    event: PendingPaymentEvent,
    type: PaymentEventType
  ): PaymentEvent {
    return {
      ...event,
      type,
    };
  }
}
