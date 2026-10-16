import { expect, test } from "@playwright/test";
import { login } from "./helpers";
import { E2E } from "./seed";

test("tokens de integração nunca chegam ao navegador", async ({ page }) => {
  const bodies: string[] = [];
  page.on("response", async (res) => {
    try {
      const type = res.headers()["content-type"] ?? "";
      if (/text|json|javascript|x-component/.test(type)) bodies.push(await res.text());
    } catch {
      // respostas sem corpo
    }
  });
  await login(page, E2E.admin);
  for (const url of ["/admin", "/admin/integracoes", "/admin/sincronizacoes", "/painel"]) {
    await page.goto(url);
    await page.waitForLoadState("networkidle");
  }
  const all = bodies.join("\n") + (await page.content());
  expect(all).not.toContain("TOKEN-SUPER-SECRETO-E2E");
  expect(all).not.toContain("credentials_encrypted");
  expect(all).not.toMatch(/scrypt\$/);
});
