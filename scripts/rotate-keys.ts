/**
 * Rotação da chave de criptografia das credenciais.
 * 1. Defina ENCRYPTION_KEY com a NOVA chave e ENCRYPTION_KEY_PREVIOUS com a antiga.
 * 2. Execute: npm run keys:rotate
 * 3. Após concluir, remova ENCRYPTION_KEY_PREVIOUS.
 */
import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import { rotateCredentialEncryption } from "../src/server/integrations/credentials";
import type { DB } from "../src/server/db/schema.generated";

const { DATABASE_URL, ENCRYPTION_KEY, ENCRYPTION_KEY_PREVIOUS } = process.env;
if (!DATABASE_URL || !ENCRYPTION_KEY) {
  console.error("Defina DATABASE_URL e ENCRYPTION_KEY (e ENCRYPTION_KEY_PREVIOUS com a chave antiga).");
  process.exit(1);
}
const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: DATABASE_URL }) }) });
rotateCredentialEncryption(db, { current: ENCRYPTION_KEY, previous: ENCRYPTION_KEY_PREVIOUS })
  .then((n) => console.log(`${n} credencial(is) recifrada(s) com a chave atual.`))
  .catch((e: unknown) => { console.error((e as Error).message); process.exitCode = 1; })
  .finally(() => db.destroy());
