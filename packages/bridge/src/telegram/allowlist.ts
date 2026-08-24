/**
 * The entire authentication boundary of this project.
 *
 * There is no tunnel and no Zero Trust in front of the bridge. Anyone who can
 * message the bot reaches this check, and the agent behind it can run shell
 * commands. A mistake here hands over the machine.
 *
 * Rules:
 *   - allow only explicitly listed numeric user ids
 *   - an empty allowlist denies everything (fail closed, never fail open)
 *   - deny silently: replying to strangers confirms the bot is live
 */
export class Allowlist {
  private readonly allowed: ReadonlySet<number>;

  constructor(userIds: readonly number[]) {
    // Reject anything non-numeric up front rather than letting NaN through:
    // NaN comparisons are always false, which would silently deny a real user.
    for (const id of userIds) {
      if (!Number.isInteger(id)) {
        throw new Error(`Allowlist entries must be integer user ids, got: ${String(id)}`);
      }
    }
    this.allowed = new Set(userIds);
  }

  /**
   * Parse a comma-separated env value such as "149523521,987654321".
   * Throws on malformed input: a typo must stop startup, not widen access.
   */
  static fromEnv(raw: string | undefined): Allowlist {
    if (raw === undefined || raw.trim() === "") return new Allowlist([]);
    const ids = raw
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part !== "")
      .map((part) => {
        if (!/^-?\d+$/.test(part)) {
          throw new Error(`Invalid user id in allowlist: ${part}`);
        }
        return Number(part);
      });
    return new Allowlist(ids);
  }

  permits(userId: number | undefined): boolean {
    if (userId === undefined) return false;
    return this.allowed.has(userId);
  }

  get size(): number {
    return this.allowed.size;
  }
}
