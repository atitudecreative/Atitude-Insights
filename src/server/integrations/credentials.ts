import type { Database } from "@/server/db";
import { decryptSecret, encryptSecret } from "@/server/security/crypto";

/** Credenciais decifradas — existem apenas em memória no servidor. */
export interface StoredCredentials {
  accessToken: string;
  refreshToken?: string;
  /** Tokens de página do Facebook (por ID de página), quando aplicável. */
  pageTokens?: Record<string, string>;
}

export interface KeyRing {
  current: string;
  previous?: string;
}

export async function saveCredentials(db: Database, accountId: string, credentials: StoredCredentials, keys: KeyRing): Promise<void> {
  await db
    .updateTable("app.connected_accounts")
    .set({ credentials_encrypted: encryptSecret(JSON.stringify(credentials), keys.current) })
    .where("id", "=", accountId)
    .execute();
}

export async function loadCredentials(db: Database, accountId: string, keys: KeyRing): Promise<StoredCredentials | null> {
  const row = await db
    .selectFrom("app.connected_accounts")
    .select("credentials_encrypted")
    .where("id", "=", accountId)
    .executeTakeFirst();
  if (!row?.credentials_encrypted) return null;
  return JSON.parse(decryptSecret(row.credentials_encrypted, [keys.current, keys.previous])) as StoredCredentials;
}

/** Recifra todas as credenciais com a chave atual (rotação de chave). */
export async function rotateCredentialEncryption(db: Database, keys: KeyRing): Promise<number> {
  const rows = await db.selectFrom("app.connected_accounts").select(["id", "credentials_encrypted"])
    .where("credentials_encrypted", "is not", null).execute();
  for (const row of rows) {
    const plain = decryptSecret(row.credentials_encrypted!, [keys.current, keys.previous]);
    await db.updateTable("app.connected_accounts").set({ credentials_encrypted: encryptSecret(plain, keys.current) })
      .where("id", "=", row.id).execute();
  }
  return rows.length;
}
