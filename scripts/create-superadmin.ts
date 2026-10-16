/**
 * Cria (ou promove) o primeiro superadministrador.
 * Uso: npm run db:seed-admin -- email@dominio "Nome Completo"
 * A senha é lida da variável ADMIN_PASSWORD ou solicitada no terminal.
 */
import { createInterface } from "node:readline/promises";
import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import { bootstrapSuperadmin } from "../src/server/auth/service";
import type { DB } from "../src/server/db/schema.generated";

async function main() {
  const [email, ...nameParts] = process.argv.slice(2);
  const name = nameParts.join(" ") || "Administrador";
  if (!email || !process.env.DATABASE_URL) {
    console.error('Uso: DATABASE_URL=... npm run db:seed-admin -- email@dominio "Nome"');
    process.exit(1);
  }
  let password = process.env.ADMIN_PASSWORD;
  if (!password) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    password = await rl.question("Senha (mín. 10 caracteres, letras e números): ");
    rl.close();
  }
  const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: process.env.DATABASE_URL }) }) });
  try {
    const id = await bootstrapSuperadmin(db, email, name, password);
    console.log(`Superadministrador pronto: ${email} (${id})`);
  } finally {
    await db.destroy();
  }
}

main().catch((e: unknown) => {
  console.error((e as Error).message);
  process.exit(1);
});
