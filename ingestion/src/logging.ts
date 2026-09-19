import pino from "pino";
import type { Env } from "./config/env.js";

export type Logger = pino.Logger;

export function createLogger(env: Pick<Env, "LOG_LEVEL">): Logger {
  return pino({ level: env.LOG_LEVEL });
}
