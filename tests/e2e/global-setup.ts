import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { seedE2E } from "./seed";

export default async function globalSetup() {
  const adminUrl = process.env.TEST_DATABASE_ADMIN_URL ?? "postgresql://atitude:atitude@localhost:5432/postgres";
  const { ids } = await seedE2E(adminUrl, process.env.E2E_DATABASE_NAME ?? "atitude_e2e");
  writeFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), ".e2e-ids.json"), JSON.stringify(ids));
}
