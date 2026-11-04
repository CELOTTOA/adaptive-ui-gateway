import { AugError } from "@aug/core";

// Hosted sandbox origins plus the native Codex scheme observed on Windows.
// Enrollment adds one exact origin, never this entire pattern, to the HTTP
// allowlist. Keep the view and server on one rule. Observed native IDs use 48 hex digits.
export const viewOriginPattern = /^(?:https:\/\/(?:[a-f0-9]{32}\.claudemcpcontent\.com|(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)?web-sandbox\.oaiusercontent\.com)|codex-sandbox:\/\/mcp-app-[a-f0-9]{48}\.web-sandbox\.oaiusercontent\.com)$/;

/** Per-process exact CORS allowlist, enrolled through the authenticated MCP connection.
 * Registration is a browser transport permission, never authorization to read data.
 */
export class ViewOriginRegistry {
  readonly allowedOrigins: string[];
  private readonly registered = new Set<string>();

  constructor(configured: string[] = []) {
    this.allowedOrigins = [...new Set(configured)];
  }

  register(origin: string): void {
    // Hosts may assign a fresh sandbox origin per conversation.
    // Do not accept arbitrary sites, wildcard domains, paths, ports or lookalikes.
    if (!viewOriginPattern.test(origin)) {
      throw new AugError("VIEW_ORIGIN_DENIED", "Unsupported view origin", 403);
    }
    if (this.allowedOrigins.includes(origin)) return;
    if (this.registered.size >= 128) {
      throw new AugError("VIEW_ORIGIN_LIMIT", "View origin limit reached; reconnect AUG", 429);
    }
    this.registered.add(origin);
    this.allowedOrigins.push(origin);
  }
}
