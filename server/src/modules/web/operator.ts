import type { Env } from "../../config/env.js";

/**
 * Who runs this node, as the web UI's imprint and privacy pages show it. Everything comes from the operator's configuration
 * (OPERATOR_*); nothing is made up. `complete` is the minimum a public German node needs to name itself - name, a postal address
 * and an e-mail address - and is what the pages and the start-up warning go by.
 */
export interface OperatorInfo {
  name: string;
  /** One entry per line. */
  address: string[];
  email: string;
  phone: string;
  representative: string;
  register: string;
  vatId: string;
  complete: boolean;
  /** The required details that are still empty (`name`, `address`, `email`). */
  missing: string[];
}

/** Lines of an address given as one variable: "\n" (written as backslash-n in an .env file) or ";" separate them. */
function splitAddress(raw: string): string[] {
  return raw
    .split(/\n|\n|;/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

export function operatorInfo(env: Pick<Env, "OPERATOR_NAME" | "OPERATOR_ADDRESS" | "OPERATOR_EMAIL" | "OPERATOR_PHONE" | "OPERATOR_REPRESENTATIVE" | "OPERATOR_REGISTER" | "OPERATOR_VAT_ID">): OperatorInfo {
  const address = splitAddress(env.OPERATOR_ADDRESS);
  const missing = [env.OPERATOR_NAME === "" ? "name" : null, address.length === 0 ? "address" : null, env.OPERATOR_EMAIL === "" ? "email" : null].filter((x): x is string => x !== null);
  return {
    name: env.OPERATOR_NAME,
    address,
    email: env.OPERATOR_EMAIL,
    phone: env.OPERATOR_PHONE,
    representative: env.OPERATOR_REPRESENTATIVE,
    register: env.OPERATOR_REGISTER,
    vatId: env.OPERATOR_VAT_ID,
    complete: missing.length === 0,
    missing,
  };
}

/** The line the node logs at start while the details are missing - plain words, once, where the operator will see it. */
export function operatorWarning(info: OperatorInfo): string | null {
  if (info.complete) return null;
  const names: Record<string, string> = { name: "OPERATOR_NAME", address: "OPERATOR_ADDRESS", email: "OPERATOR_EMAIL" };
  return `The web UI's imprint (/imprint) has no operator details yet: ${info.missing.map((m) => names[m]).join(", ")} ${info.missing.length === 1 ? "is" : "are"} not set. A public node needs them (docs/web-ui.md, "Legal pages"); until then the page says so.`;
}
