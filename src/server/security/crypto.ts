import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Criptografia de credenciais persistidas (AES-256-GCM).
 * Formato: v1.<iv>.<tag>.<ciphertext> (base64url). A chave anterior
 * (ENCRYPTION_KEY_PREVIOUS) é aceita na leitura para permitir rotação.
 */
function parseKey(base64: string): Buffer {
  const key = Buffer.from(base64, "base64");
  if (key.length !== 32) throw new Error("A chave de criptografia deve ter 32 bytes");
  return key;
}

export function encryptSecret(plain: string, keyBase64: string): string {
  const key = parseKey(keyBase64);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(".");
}

export function decryptSecret(payload: string, keys: Array<string | undefined>): string {
  const [version, iv, tag, data] = payload.split(".");
  if (version !== "v1" || !iv || !tag || !data) throw new Error("Formato de segredo inválido");
  for (const keyBase64 of keys) {
    if (!keyBase64) continue;
    try {
      const decipher = createDecipheriv("aes-256-gcm", parseKey(keyBase64), Buffer.from(iv, "base64url"));
      decipher.setAuthTag(Buffer.from(tag, "base64url"));
      return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
    } catch {
      // tenta a próxima chave
    }
  }
  throw new Error("Não foi possível decifrar a credencial (chave incorreta ou dado corrompido)");
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Remove tokens e segredos de mensagens antes de registrá-las em logs. */
export function redactSecrets(text: string): string {
  return text
    .replace(/(access_token|refresh_token|client_secret|fb_exchange_token|code|token)=([^&\s"']+)/gi, "$1=[REDACTED]")
    .replace(/Bearer\s+[A-Za-z0-9._\-~+/=:]+/gi, "Bearer [REDACTED]")
    .replace(/\b(EAA[A-Za-z0-9]{20,})\b/g, "[REDACTED]")
    .replace(/\b\d\/\d{10,}:[A-Za-z0-9]{20,}\b/g, "[REDACTED]");
}
