/** Staff screens. Kiosk inactivity must never send these back to the title. */
const OPERATOR_ROUTE_NAMES = new Set(["admin", "login", "reprint", "gallery"]);

export function isOperatorRoute(name: unknown): boolean {
  return OPERATOR_ROUTE_NAMES.has(String(name ?? ""));
}
