/**
 * Bill-acceptor adapter seam.
 *
 * This is the SINGLE place the future LumaBooth integration plugs in.
 * The rest of the app only ever talks to the payment store
 * (`usePaymentStore`). This file's job is to translate "a bill went
 * in" events from whatever external source LumaBooth ends up using
 * into `paymentStore.addCredit()` / `.fail()` calls.
 *
 * WHY A SEAM
 * ----------
 * The transport is undecided (could be Electron IPC from a helper
 * process, a serial/USB acceptor, a localhost webhook, a global
 * hotkey…). By funnelling everything through one `BillAcceptorAdapter`
 * interface we can swap the real implementation in later without
 * touching the store or any Vue component.
 *
 * WHAT EXISTS TODAY
 * -----------------
 *   - `BillAcceptorAdapter`   — the contract a real adapter implements
 *   - `MockBillAcceptorAdapter` — dev/testing: credit is injected by
 *      the UI's debug buttons (no hardware, no LumaBooth)
 *   - `IpcBillAcceptorAdapter`  — listens on the `payment:credit`
 *      Electron IPC channel (stubbed in preload/main). This is the
 *      most likely LumaBooth hook: a LumaBooth-side helper emits
 *      credit events to the main process, which forwards them here.
 *   - `createBillAcceptorAdapter()` — picks an adapter based on env
 *
 * TODO(lumabooth): once the LumaBooth side is specified, either
 *   (a) finish IpcBillAcceptorAdapter + the electron `payment:*`
 *       handlers to consume LumaBooth's real signal, or
 *   (b) add a new adapter class here (serial, HTTP, hotkey, …) and
 *       return it from createBillAcceptorAdapter(). Nothing outside
 *       this file should need to change.
 */
import type { usePaymentStore } from "@/stores/payment";

type PaymentStore = ReturnType<typeof usePaymentStore>;

export interface BillAcceptorAdapter {
  /** Human-readable id for logs / diagnostics. */
  readonly name: string;
  /**
   * Begin listening for credit events and forward them to the store.
   * Must be idempotent — calling start() twice should not double-wire.
   */
  start(store: PaymentStore): void;
  /** Stop listening and release any resources. */
  stop(): void;
  /**
   * Optional: manually inject credit (used by the dev mock and the
   * BillAcceptorView debug controls). Real hardware adapters can
   * leave this undefined.
   */
  simulateCredit?(amount: number): void;
}

/**
 * Dev / testing adapter. No hardware. Credit only arrives when the
 * UI calls `simulateCredit()` (wired to debug buttons on the
 * BillAcceptorView). This lets the screen be exercised end-to-end
 * before LumaBooth exists.
 */
export class MockBillAcceptorAdapter implements BillAcceptorAdapter {
  readonly name = "mock";
  private store: PaymentStore | null = null;

  start(store: PaymentStore): void {
    this.store = store;
    console.log("[BillAcceptor] Mock adapter active (debug credit only)");
  }

  stop(): void {
    this.store = null;
  }

  simulateCredit(amount: number): void {
    if (!this.store) {
      console.warn("[BillAcceptor] simulateCredit before start() — ignored");
      return;
    }
    console.log(`[BillAcceptor] (mock) credit +${amount}`);
    this.store.addCredit(amount);
  }
}

/**
 * IPC adapter. Listens for `payment:credit` / `payment:error` events
 * forwarded by the Electron main process. The main process is where
 * a LumaBooth-side helper (or a serial reader, etc.) will ultimately
 * push events from — see electron/main.js `payment:*` STUB.
 *
 * Safe to use even before the electron side is implemented: if the
 * preload bridge isn't present it logs once and behaves like a no-op,
 * so dev in a plain browser / pre-integration build doesn't crash.
 */
export class IpcBillAcceptorAdapter implements BillAcceptorAdapter {
  readonly name = "ipc";
  private store: PaymentStore | null = null;
  private offCredit: (() => void) | null = null;

  start(store: PaymentStore): void {
    this.store = store;
    // window.electronAPI is typed via the global Window augmentation
    // in src/env.d.ts (onPaymentCredit is optional there).
    const api = window.electronAPI;
    if (!api?.onPaymentCredit) {
      console.warn(
        "[BillAcceptor] electronAPI.onPaymentCredit missing — IPC adapter is a no-op until the electron payment:* stub is implemented",
      );
      return;
    }
    // The preload bridge returns an unsubscribe fn (see preload.js).
    this.offCredit = api.onPaymentCredit(
      (evt: {
        amount?: number;
        error?: string;
        paidInFull?: boolean;
        source?: string;
      }) => {
        const s = this.store;
        if (!s) return;
        if (evt.error) {
          s.fail(evt.error);
          return;
        }
        // LumaBooth Middleware signal: it owns pricing/denominations
        // internally and only reports COMPLETED sales (one
        // /api/start call = one fully-paid session), so satisfy the
        // sale outright rather than adding a bill amount.
        if (evt.paidInFull) {
          console.log(
            `[BillAcceptor] (ipc) session paid in full via ${evt.source ?? "middleware"}`,
          );
          if (s.status === "idle") s.beginSession();
          if (s.remaining > 0) s.addCredit(s.remaining);
          return;
        }
        if (typeof evt.amount === "number" && evt.amount > 0) {
          console.log(`[BillAcceptor] (ipc) credit +${evt.amount}`);
          s.addCredit(evt.amount);
        }
      },
    );
    console.log("[BillAcceptor] IPC adapter active (payment:credit)");
  }

  stop(): void {
    this.offCredit?.();
    this.offCredit = null;
    this.store = null;
  }
}

/**
 * Adapter factory. The transport is now real: inside Electron the IPC
 * adapter receives the LumaBooth Middleware's payment signal (electron
 * main impersonates the LumaBooth API on localhost:1500 and forwards
 * /api/start calls as `payment:credit` events). In a plain browser
 * (no electronAPI) fall back to the mock so the screen stays
 * exercisable with the debug buttons. VITE_BILL_ACCEPTOR=mock|ipc
 * still overrides for testing.
 */
export function createBillAcceptorAdapter(): BillAcceptorAdapter {
  const mode = String(
    import.meta.env.VITE_BILL_ACCEPTOR ?? "auto",
  ).toLowerCase();
  switch (mode) {
    case "ipc":
      return new IpcBillAcceptorAdapter();
    case "mock":
      return new MockBillAcceptorAdapter();
    case "auto":
    default:
      return window.electronAPI?.onPaymentCredit
        ? new IpcBillAcceptorAdapter()
        : new MockBillAcceptorAdapter();
  }
}
