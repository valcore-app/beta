import { existsSync, mkdirSync } from "fs";
import { dirname, resolve } from "path";
import { env } from "./env.js";

export const resolveDataDir = () => {
  const candidates = [
    dirname(resolve(process.cwd(), env.ORACLE_DB_PATH)),
    resolve(process.cwd(), "apps", "oracle", "data"),
    resolve(process.cwd(), "data"),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  const fallback = candidates[0];
  mkdirSync(fallback, { recursive: true });
  return fallback;
};
