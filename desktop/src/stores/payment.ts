/**
 * Payment store — the state machine the bill-acceptor screen runs on.
 *
 * SCOPE / INTENT
 * --------------
 * This is deliberately a thin, transport-agnostic abstraction. The
 * actual bill-acceptor hardware will be driven by a LumaBooth-side
 * integration that we don't own yet. When that integration is ready,
 * it only has to call a couple of methods on this store:
 *
 *   - `beginSession(priceRequired)` — arm the acceptor for a new sale
 *   - `addCredit(amount)`           — call once per accepted bill/coin
 *   - `fail(message)`               — acceptor jammed / rejected, etc.
 *   - `reset()`                     — clear back to idle
 *
 * Everything the UI needs (`status`, `isPaid`, `remaining`, …) is
 * derived from those calls, so the LumaBooth adapter never has to
 * touch Vue components directly. See `src/services/billAcceptor.ts`
 * for the adapter seam that bridges external signals → these methods.
 *
 * NOTHING here talks to hardware or LumaBooth — that's intentional.
 * Keep transport concerns in the adapter so this store stays unit-
 * testable and the integration point stays a single, obvious file.
 */
import { defineStore } from "pinia";
import { ref, computed } from "vue";

export type PaymentStatus =
  | "idle" // no sale in progress
  | "awaiting" // armed, waiting for the customer to insert money
  | "paid" // enough credit received — flow may proceed
  | "error"; // acceptor reported a fault

// Default price (in whole currency units) for one photo session.
// Override via VITE_SESSION_PRICE in .env; admins can later get a UI
// for this. Kept as a number of whole units (e.g. PHP 100) — the
// acceptor adapter is responsible for translating bill denominations
// into the same unit before calling addCredit().
const DEFAULT_SESSION_PRICE = Number(
  import.meta.env.VITE_SESSION_PRICE ?? 100,
);
const CURRENCY = String(import.meta.env.VITE_CURRENCY ?? "PHP");

export const usePaymentStore = defineStore("payment", () => {
  const status = ref<PaymentStatus>("idle");
  /** Whole currency units required for the current sale. */
  const amountRequired = ref(0);
  /** Whole currency units inserted so far this sale. */
  const amountReceived = ref(0);
  /** Last fault message from the acceptor (empty when none). */
  const lastError = ref("");
  /** ISO timestamp the current session was armed (for diagnostics). */
  const sessionStartedAt = ref<string | null>(null);
  const currency = ref(CURRENCY);

  /** True once enough money is in to cover the price. */
  const isPaid = computed(
    () =>
      status.value === "paid" ||
      (amountRequired.value > 0 &&
        amountReceived.value >= amountRequired.value),
  );

  /** Remaining balance the customer still owes (never negative). */
  const remaining = computed(() =>
    Math.max(0, amountRequired.value - amountReceived.value),
  );

  /** Any overpayment to surface as "change due" / "no change given". */
  const overpaid = computed(() =>
    Math.max(0, amountReceived.value - amountRequired.value),
  );

  /**
   * Arm the acceptor for a new sale. Call this when the bill-acceptor
   * screen mounts. `priceRequired` defaults to the configured session
   * price but callers may override (e.g. a promo, a multi-print order).
   */
  function beginSession(priceRequired: number = DEFAULT_SESSION_PRICE) {
    amountRequired.value = Math.max(0, priceRequired);
    amountReceived.value = 0;
    lastError.value = "";
    sessionStartedAt.value = new Date().toISOString();
    // A zero price means "free mode" — instantly satisfied so the
    // operator can disable payment without ripping this screen out.
    status.value = amountRequired.value === 0 ? "paid" : "awaiting";
  }

  /**
   * Register accepted money. The LumaBooth / hardware adapter calls
   * this once per validated bill or coin with the value in whole
   * currency units. Auto-promotes to "paid" when the threshold is met.
   */
  function addCredit(amount: number) {
    if (amount <= 0) return;
    if (status.value === "idle") {
      // Defensive: if credit arrives before beginSession (race with
      // the adapter), arm with the default price so money is never
      // silently dropped.
      beginSession();
    }
    amountReceived.value += amount;
    if (amountReceived.value >= amountRequired.value) {
      status.value = "paid";
    } else if (status.value !== "error") {
      status.value = "awaiting";
    }
  }

  /** Acceptor fault (jam, validation failure, comms loss, …). */
  function fail(message: string) {
    lastError.value = message || "Bill acceptor error";
    status.value = "error";
  }

  /**
   * Mark the received credit as consumed by the session that just
   * started (call right before navigating away from the payment
   * screen) so a back-navigation can't reuse the same payment.
   */
  function consume() {
    status.value = "idle";
    amountRequired.value = 0;
    amountReceived.value = 0;
    sessionStartedAt.value = null;
  }

  /** Hard reset back to idle (e.g. customer cancelled / timed out). */
  function reset() {
    status.value = "idle";
    amountRequired.value = 0;
    amountReceived.value = 0;
    lastError.value = "";
    sessionStartedAt.value = null;
  }

  return {
    // state
    status,
    amountRequired,
    amountReceived,
    lastError,
    sessionStartedAt,
    currency,
    // derived
    isPaid,
    remaining,
    overpaid,
    // actions (the LumaBooth adapter calls beginSession/addCredit/fail)
    beginSession,
    addCredit,
    fail,
    consume,
    reset,
  };
});
