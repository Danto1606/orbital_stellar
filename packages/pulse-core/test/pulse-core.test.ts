import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type StreamHandlers = {
  onmessage: (record: unknown) => void;
  onerror: (error: unknown) => void;
};

type MockStreamInstance = {
  handlers: StreamHandlers;
  close: ReturnType<typeof vi.fn>;
};

const streamInstances: MockStreamInstance[] = [];

vi.mock("@stellar/stellar-sdk", () => {
  class MockServer {
    constructor(_url: string) {}

    operations() {
      return {
        cursor() {
          return {
            stream(handlers: StreamHandlers) {
              const close = vi.fn();
              streamInstances.push({ handlers, close });
              return close;
            },
          };
        },
      };
    }
  }

  return {
    Horizon: {
      Server: MockServer,
    },
  };
});

import { EventEngine } from "../src/EventEngine.js";

function latestStream(): MockStreamInstance {
  const stream = streamInstances.at(-1);
  if (!stream) {
    throw new Error("Expected an active mock stream.");
  }

  return stream;
}

describe("pulse-core EventEngine", () => {
  const log = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  beforeEach(() => {
    streamInstances.length = 0;
    vi.useFakeTimers();
    log.info.mockReset();
    log.warn.mockReset();
    log.error.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("normalizes payments without hardcoding payment.received", () => {
    const engine = new EventEngine({ network: "testnet" });
    const normalize = (
      engine as unknown as {
        normalize(record: unknown): unknown;
      }
    ).normalize.bind(engine);

    const normalized = normalize({
      type: "payment",
      to: "GDEST",
      from: "GSRC",
      amount: "42",
      asset_type: "credit_alphanum4",
      asset_code: "USDC",
      asset_issuer: "GISSUER",
      created_at: "2026-03-26T20:00:00.000Z",
    });

    expect(normalized).toEqual({
      type: "unknown",
      to: "GDEST",
      from: "GSRC",
      amount: "42",
      asset: "USDC:GISSUER",
      timestamp: "2026-03-26T20:00:00.000Z",
      raw: {
        type: "payment",
        to: "GDEST",
        from: "GSRC",
        amount: "42",
        asset_type: "credit_alphanum4",
        asset_code: "USDC",
        asset_issuer: "GISSUER",
        created_at: "2026-03-26T20:00:00.000Z",
      },
    });
  });

  it("empties the registry via stop handlers when stop() is called", () => {
    const engine = new EventEngine({ network: "testnet" });
    engine.subscribe("GABC");
    engine.subscribe("GDEF");

    const registry = (engine as unknown as { registry: Map<string, unknown> })
      .registry;
    expect(registry.size).toBe(2);

    engine.stop();

    expect(registry.size).toBe(0);
  });

  it("returns null and warns when a required payment field is missing", () => {
    const engine = new EventEngine({ network: "testnet", logger: log });
    const normalize = (
      engine as unknown as {
        normalize(record: unknown): unknown;
      }
    ).normalize.bind(engine);

    // Missing `to`
    const result = normalize({
      type: "payment",
      from: "GSRC",
      amount: "42",
      asset_type: "native",
      created_at: "2026-03-26T20:00:00.000Z",
    });

    expect(result).toBeNull();
    expect(log.warn).toHaveBeenCalledWith(
      '[pulse-core] normalize() dropping payment record: field "to" is missing or not a non-empty string.'
    );
  });

  it("returns null and warns for each missing required field individually", () => {
    const engine = new EventEngine({ network: "testnet", logger: log });
    const normalize = (
      engine as unknown as {
        normalize(record: unknown): unknown;
      }
    ).normalize.bind(engine);

    const missingFieldCases: Array<[string, Record<string, unknown>]> = [
      ["from",       { type: "payment", to: "GDEST", amount: "1", created_at: "2026-01-01T00:00:00Z" }],
      ["amount",     { type: "payment", to: "GDEST", from: "GSRC", created_at: "2026-01-01T00:00:00Z" }],
      ["created_at", { type: "payment", to: "GDEST", from: "GSRC", amount: "1" }],
    ];

    for (const [field, record] of missingFieldCases) {
      log.warn.mockReset();
      const result = normalize(record);
      expect(result).toBeNull();
      expect(log.warn).toHaveBeenCalledWith(
        `[pulse-core] normalize() dropping payment record: field "${field}" is missing or not a non-empty string.`
      );
    }
  });

  it("removes stopped watchers from the registry and keeps stop idempotent", () => {
    const engine = new EventEngine({ network: "testnet" });
    const watcher = engine.subscribe("GABC");

    expect(
      (engine as unknown as { registry: Map<string, unknown> }).registry.has("GABC")
    ).toBe(true);

    watcher.stop();
    watcher.stop();

    expect(
      (engine as unknown as { registry: Map<string, unknown> }).registry.has("GABC")
    ).toBe(false);
    expect(engine.subscribe("GABC")).not.toBe(watcher);
  });

  it("guards start() so duplicate live streams are not opened", () => {
    const engine = new EventEngine({ network: "testnet", logger: log });

    engine.start();
    engine.start();

    expect(streamInstances).toHaveLength(1);
    expect(log.warn).toHaveBeenCalledWith(
      "[pulse-core] EventEngine.start() called while the SSE stream is already active."
    );
  });

  it("reconnects with exponential backoff and emits watcher notifications", () => {
    const engine = new EventEngine({
      network: "testnet",
      logger: log,
      reconnect: {
        initialDelayMs: 1000,
        maxDelayMs: 30000,
      },
    });

    const watcher = engine.subscribe("GABC");
    const reconnecting = vi.fn();
    const reconnected = vi.fn();
    watcher.on("engine.reconnecting", reconnecting);
    watcher.on("engine.reconnected", reconnected);

    engine.start();

    latestStream().handlers.onerror(new Error("stream dropped"));

    expect(streamInstances[0]?.close).toHaveBeenCalledTimes(1);
    expect(reconnecting).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "engine.reconnecting",
        attempt: 1,
        delayMs: 1000,
      })
    );
    expect(log.warn).toHaveBeenCalledWith(
      "[pulse-core] SSE reconnect attempt 1 scheduled in 1000ms."
    );
    expect(streamInstances).toHaveLength(1);

    vi.advanceTimersByTime(1000);

    expect(streamInstances).toHaveLength(2);

    latestStream().handlers.onerror(new Error("stream dropped again"));

    expect(streamInstances[1]?.close).toHaveBeenCalledTimes(1);
    expect(reconnecting).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: "engine.reconnecting",
        attempt: 2,
        delayMs: 2000,
      })
    );
    expect(log.warn).toHaveBeenLastCalledWith(
      "[pulse-core] SSE reconnect attempt 2 scheduled in 2000ms."
    );

    vi.advanceTimersByTime(2000);

    expect(streamInstances).toHaveLength(3);

    latestStream().handlers.onmessage({
      type: "payment",
      to: "GABC",
      from: "GSRC",
      amount: "10",
      asset_type: "native",
      created_at: "2026-03-26T20:00:00.000Z",
    });

    expect(reconnected).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "engine.reconnected",
        attempt: 2,
      })
    );
    expect(log.info).toHaveBeenCalledWith(
      "[pulse-core] SSE reconnect succeeded on attempt 2."
    );

    latestStream().handlers.onerror(new Error("stream dropped after recovery"));

    expect(reconnecting).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: "engine.reconnecting",
        attempt: 1,
        delayMs: 1000,
      })
    );
  });

  describe("set_options → account.options_changed", () => {
    function makeSetOptionsRecord(
      overrides: Record<string, unknown>
    ): Record<string, unknown> {
      return {
        type: "set_options",
        source_account: "GSRC",
        created_at: "2026-04-24T10:00:00.000Z",
        ...overrides,
      };
    }

    it("emits account.options_changed with signer_added when signer_weight > 0", () => {
      const engine = new EventEngine({ network: "testnet" });
      const watcher = engine.subscribe("GSRC");
      const handler = vi.fn();
      watcher.on("account.options_changed", handler);

      engine.start();
      latestStream().handlers.onmessage(
        makeSetOptionsRecord({ signer_key: "GNEWSIGNER", signer_weight: 2 })
      );

      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "account.options_changed",
          source: "GSRC",
          changes: { signer_added: { key: "GNEWSIGNER", weight: 2 } },
          timestamp: "2026-04-24T10:00:00.000Z",
        })
      );
    });

    it("emits account.options_changed with signer_removed when signer_weight is 0", () => {
      const engine = new EventEngine({ network: "testnet" });
      const watcher = engine.subscribe("GSRC");
      const handler = vi.fn();
      watcher.on("account.options_changed", handler);

      engine.start();
      latestStream().handlers.onmessage(
        makeSetOptionsRecord({ signer_key: "GOLDSIGNER", signer_weight: 0 })
      );

      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "account.options_changed",
          source: "GSRC",
          changes: { signer_removed: { key: "GOLDSIGNER", weight: 0 } },
        })
      );
    });

    it("emits account.options_changed with thresholds when any threshold field is present", () => {
      const engine = new EventEngine({ network: "testnet" });
      const watcher = engine.subscribe("GSRC");
      const handler = vi.fn();
      watcher.on("account.options_changed", handler);

      engine.start();
      latestStream().handlers.onmessage(
        makeSetOptionsRecord({
          low_threshold: 1,
          med_threshold: 2,
          high_threshold: 3,
          master_key_weight: 1,
        })
      );

      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "account.options_changed",
          source: "GSRC",
          changes: {
            thresholds: {
              low_threshold: 1,
              med_threshold: 2,
              high_threshold: 3,
              master_key_weight: 1,
            },
          },
        })
      );
    });

    it("emits account.options_changed with home_domain when home_domain is present", () => {
      const engine = new EventEngine({ network: "testnet" });
      const watcher = engine.subscribe("GSRC");
      const handler = vi.fn();
      watcher.on("account.options_changed", handler);

      engine.start();
      latestStream().handlers.onmessage(
        makeSetOptionsRecord({ home_domain: "example.com" })
      );

      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "account.options_changed",
          source: "GSRC",
          changes: { home_domain: "example.com" },
        })
      );
    });

    it("only includes fields that are actually present in changes", () => {
      const engine = new EventEngine({ network: "testnet" });
      const watcher = engine.subscribe("GSRC");
      const handler = vi.fn();
      watcher.on("account.options_changed", handler);

      engine.start();
      latestStream().handlers.onmessage(
        makeSetOptionsRecord({ home_domain: "stellar.org", low_threshold: 5 })
      );

      expect(handler).toHaveBeenCalledOnce();
      const payload = handler.mock.calls[0]![0];
      expect(payload.changes).toEqual({
        home_domain: "stellar.org",
        thresholds: { low_threshold: 5 },
      });
      expect(payload.changes).not.toHaveProperty("signer_added");
      expect(payload.changes).not.toHaveProperty("signer_removed");
    });

    it("does not emit when set_options has no recognized changed fields", () => {
      const engine = new EventEngine({ network: "testnet" });
      const watcher = engine.subscribe("GSRC");
      const handler = vi.fn();
      watcher.on("account.options_changed", handler);

      engine.start();
      latestStream().handlers.onmessage(
        makeSetOptionsRecord({ set_flags: 1 })
      );

      expect(handler).not.toHaveBeenCalled();
    });

    it("does not route account.options_changed to unrelated watchers", () => {
      const engine = new EventEngine({ network: "testnet" });
      const srcWatcher = engine.subscribe("GSRC");
      const otherWatcher = engine.subscribe("GOTHER");
      const srcHandler = vi.fn();
      const otherHandler = vi.fn();
      srcWatcher.on("account.options_changed", srcHandler);
      otherWatcher.on("account.options_changed", otherHandler);

      engine.start();
      latestStream().handlers.onmessage(
        makeSetOptionsRecord({ home_domain: "example.com" })
      );

      expect(srcHandler).toHaveBeenCalledOnce();
      expect(otherHandler).not.toHaveBeenCalled();
    });
  });

  describe("allow_trust → trustline.authorized / trustline.deauthorized", () => {
    function makeAllowTrustRecord(
      overrides: Record<string, unknown>
    ): Record<string, unknown> {
      return {
        type: "allow_trust",
        source_account: "GISSUER",
        trustee: "GISSUER",
        trustor: "GTRUSTOR",
        asset_type: "credit_alphanum4",
        asset_code: "USDC",
        asset_issuer: "GISSUER",
        created_at: "2026-04-24T10:00:00.000Z",
        ...overrides,
      };
    }

    it("emits trustline.authorized when authorize is true", () => {
      const engine = new EventEngine({ network: "testnet" });
      const issuerWatcher = engine.subscribe("GISSUER");
      const trustorWatcher = engine.subscribe("GTRUSTOR");
      const issuerHandler = vi.fn();
      const trustorHandler = vi.fn();
      issuerWatcher.on("trustline.authorized", issuerHandler);
      trustorWatcher.on("trustline.authorized", trustorHandler);

      engine.start();
      latestStream().handlers.onmessage(
        makeAllowTrustRecord({ authorize: true })
      );

      expect(issuerHandler).toHaveBeenCalledOnce();
      expect(trustorHandler).toHaveBeenCalledOnce();
      expect(issuerHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "trustline.authorized",
          trustor: "GTRUSTOR",
          issuer: "GISSUER",
          asset: "USDC:GISSUER",
          operation: "allow_trust",
          timestamp: "2026-04-24T10:00:00.000Z",
        })
      );
    });

    it("emits trustline.deauthorized when authorize is false", () => {
      const engine = new EventEngine({ network: "testnet" });
      const issuerWatcher = engine.subscribe("GISSUER");
      const trustorWatcher = engine.subscribe("GTRUSTOR");
      const issuerHandler = vi.fn();
      const trustorHandler = vi.fn();
      issuerWatcher.on("trustline.deauthorized", issuerHandler);
      trustorWatcher.on("trustline.deauthorized", trustorHandler);

      engine.start();
      latestStream().handlers.onmessage(
        makeAllowTrustRecord({ authorize: false })
      );

      expect(issuerHandler).toHaveBeenCalledOnce();
      expect(trustorHandler).toHaveBeenCalledOnce();
      expect(issuerHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "trustline.deauthorized",
          trustor: "GTRUSTOR",
          issuer: "GISSUER",
          asset: "USDC:GISSUER",
          operation: "allow_trust",
        })
      );
    });

    it("does not emit to unrelated watchers", () => {
      const engine = new EventEngine({ network: "testnet" });
      engine.subscribe("GISSUER");
      const otherWatcher = engine.subscribe("GOTHER");
      const otherHandler = vi.fn();
      otherWatcher.on("trustline.authorized", otherHandler);

      engine.start();
      latestStream().handlers.onmessage(
        makeAllowTrustRecord({ authorize: true })
      );

      expect(otherHandler).not.toHaveBeenCalled();
    });

    it("handles native asset correctly", () => {
      const engine = new EventEngine({ network: "testnet" });
      const issuerWatcher = engine.subscribe("GISSUER");
      const handler = vi.fn();
      issuerWatcher.on("trustline.authorized", handler);

      engine.start();
      latestStream().handlers.onmessage(
        makeAllowTrustRecord({
          asset_type: "native",
          asset_code: undefined,
          asset_issuer: undefined,
          authorize: true,
        })
      );

      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          asset: "XLM",
        })
      );
    });
  });

  describe("set_trust_line_flags → trustline.authorized / trustline.deauthorized", () => {
    function makeSetTrustLineFlagsRecord(
      overrides: Record<string, unknown>
    ): Record<string, unknown> {
      return {
        type: "set_trust_line_flags",
        source_account: "GISSUER",
        trustor: "GTRUSTOR",
        asset_type: "credit_alphanum4",
        asset_code: "USDC",
        asset_issuer: "GISSUER",
        set_flags_s: [],
        clear_flags_s: [],
        created_at: "2026-04-24T10:00:00.000Z",
        ...overrides,
      };
    }

    it("emits trustline.authorized when authorized flag is set", () => {
      const engine = new EventEngine({ network: "testnet" });
      const issuerWatcher = engine.subscribe("GISSUER");
      const trustorWatcher = engine.subscribe("GTRUSTOR");
      const issuerHandler = vi.fn();
      const trustorHandler = vi.fn();
      issuerWatcher.on("trustline.authorized", issuerHandler);
      trustorWatcher.on("trustline.authorized", trustorHandler);

      engine.start();
      latestStream().handlers.onmessage(
        makeSetTrustLineFlagsRecord({
          set_flags_s: ["authorized"],
          clear_flags_s: [],
        })
      );

      expect(issuerHandler).toHaveBeenCalledOnce();
      expect(trustorHandler).toHaveBeenCalledOnce();
      expect(issuerHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "trustline.authorized",
          trustor: "GTRUSTOR",
          issuer: "GISSUER",
          asset: "USDC:GISSUER",
          operation: "set_trust_line_flags",
          timestamp: "2026-04-24T10:00:00.000Z",
        })
      );
    });

    it("emits trustline.deauthorized when authorized flag is cleared", () => {
      const engine = new EventEngine({ network: "testnet" });
      const issuerWatcher = engine.subscribe("GISSUER");
      const trustorWatcher = engine.subscribe("GTRUSTOR");
      const issuerHandler = vi.fn();
      const trustorHandler = vi.fn();
      issuerWatcher.on("trustline.deauthorized", issuerHandler);
      trustorWatcher.on("trustline.deauthorized", trustorHandler);

      engine.start();
      latestStream().handlers.onmessage(
        makeSetTrustLineFlagsRecord({
          set_flags_s: [],
          clear_flags_s: ["authorized"],
        })
      );

      expect(issuerHandler).toHaveBeenCalledOnce();
      expect(trustorHandler).toHaveBeenCalledOnce();
      expect(issuerHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "trustline.deauthorized",
          trustor: "GTRUSTOR",
          issuer: "GISSUER",
          asset: "USDC:GISSUER",
          operation: "set_trust_line_flags",
        })
      );
    });

    it("does not emit when authorized flag is both set and cleared", () => {
      const engine = new EventEngine({ network: "testnet" });
      const issuerWatcher = engine.subscribe("GISSUER");
      const handler = vi.fn();
      issuerWatcher.on("trustline.authorized", handler);

      engine.start();
      latestStream().handlers.onmessage(
        makeSetTrustLineFlagsRecord({
          set_flags_s: ["authorized"],
          clear_flags_s: ["authorized"],
        })
      );

      expect(handler).not.toHaveBeenCalled();
    });

    it("does not emit when no authorization flag changes", () => {
      const engine = new EventEngine({ network: "testnet" });
      const issuerWatcher = engine.subscribe("GISSUER");
      const handler = vi.fn();
      issuerWatcher.on("trustline.authorized", handler);

      engine.start();
      latestStream().handlers.onmessage(
        makeSetTrustLineFlagsRecord({
          set_flags_s: ["clawback_enabled"],
          clear_flags_s: [],
        })
      );

      expect(handler).not.toHaveBeenCalled();
    });

    it("does not route to unrelated watchers", () => {
      const engine = new EventEngine({ network: "testnet" });
      engine.subscribe("GISSUER");
      const otherWatcher = engine.subscribe("GOTHER");
      const otherHandler = vi.fn();
      otherWatcher.on("trustline.authorized", otherHandler);

      engine.start();
      latestStream().handlers.onmessage(
        makeSetTrustLineFlagsRecord({
          set_flags_s: ["authorized"],
          clear_flags_s: [],
        })
      );

      expect(otherHandler).not.toHaveBeenCalled();
    });
  });
});
