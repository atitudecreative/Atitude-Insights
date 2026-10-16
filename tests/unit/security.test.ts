import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { hashPassword, passwordPolicyError, verifyPassword } from "@/server/auth/password";
import { decryptSecret, encryptSecret, redactSecrets } from "@/server/security/crypto";

describe("criptografia de credenciais", () => {
  const key = randomBytes(32).toString("base64");
  it("cifra e decifra; texto cifrado não contém o segredo", () => {
    const enc = encryptSecret("EAAB-segredo-123", key);
    expect(enc).not.toContain("segredo");
    expect(decryptSecret(enc, [key])).toBe("EAAB-segredo-123");
  });
  it("usa IV aleatório", () => expect(encryptSecret("x", key)).not.toBe(encryptSecret("x", key)));
  it("chave errada falha; rotação aceita chave anterior", () => {
    const other = randomBytes(32).toString("base64");
    const enc = encryptSecret("abc", key);
    expect(() => decryptSecret(enc, [other])).toThrow();
    expect(decryptSecret(enc, [other, key])).toBe("abc");
  });
  it("detecta adulteração", () => {
    const enc = encryptSecret("abc", key);
    const parts = enc.split(".");
    parts[3] = Buffer.from("zzz").toString("base64url");
    expect(() => decryptSecret(parts.join("."), [key])).toThrow();
  });
  it("redige tokens de mensagens", () => {
    const msg = redactSecrets("GET https://graph.facebook.com/me?access_token=EAABsecret123&x=1 Bearer 1/12345678901:abcdefghijklmnopqrstuvwxyz");
    expect(msg).not.toContain("EAABsecret123");
    expect(msg).not.toContain("abcdefghijklmnopqrstuvwxyz");
  });
});

describe("senhas", () => {
  it("hash scrypt verificável e resistente a senha errada", async () => {
    const hash = await hashPassword("SenhaForte123");
    expect(hash.startsWith("scrypt$")).toBe(true);
    expect(await verifyPassword("SenhaForte123", hash)).toBe(true);
    expect(await verifyPassword("senhaforte123", hash)).toBe(false);
    expect(await verifyPassword("x", null)).toBe(false);
  });
  it("política mínima", () => {
    expect(passwordPolicyError("curta1")).not.toBeNull();
    expect(passwordPolicyError("somenteletrasaqui")).not.toBeNull();
    expect(passwordPolicyError("Valida12345")).toBeNull();
  });
});
