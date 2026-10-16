import { expect, test } from "@playwright/test";
import { login } from "./helpers";
import { E2E } from "./seed";

test.describe("Autenticação", () => {
  test("página protegida redireciona para o login", async ({ page }) => {
    await page.goto("/painel");
    await expect(page).toHaveURL(/\/login/);
  });

  test("senha errada mostra erro genérico", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("E-mail").fill(E2E.leaderA);
    await page.getByLabel("Senha").fill("senha-errada-123");
    await page.getByRole("button", { name: "Entrar" }).click();
    await expect(page.getByText("E-mail ou senha inválidos.")).toBeVisible();
  });

  test("login, cookie protegido e logout invalidam a sessão", async ({ page, context }) => {
    await login(page, E2E.leaderA);
    await expect(page).toHaveURL(/\/ministerios\/atitude-kids/);
    const cookie = (await context.cookies()).find((c) => c.name === "ai_session");
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite).toBe("Lax");
    const stolen = cookie!.value;
    await page.getByRole("button", { name: "Sair" }).first().click();
    await expect(page).toHaveURL(/\/login/);
    // Reutilizar o token após o logout não funciona (revogado no servidor).
    await context.addCookies([{ ...cookie!, value: stolen }]);
    await page.goto("/painel");
    await expect(page).toHaveURL(/\/login/);
  });

  test("APIs exigem sessão", async ({ request }) => {
    expect((await request.get("/api/relatorios/pdf?escopo=agency")).status()).toBe(401);
    expect((await request.get("/api/cron/sync")).status()).toBe(401);
    expect((await request.get("/api/cron/sync", { headers: { authorization: "Bearer errado" } })).status()).toBe(401);
  });

  test("open redirect no parâmetro next é bloqueado", async ({ page }) => {
    await page.goto("/login?next=//evil.example.com");
    await page.getByLabel("E-mail").fill(E2E.agency);
    await page.getByLabel("Senha").fill("SenhaE2E12345");
    await page.getByRole("button", { name: "Entrar" }).click();
    await expect(page).toHaveURL(/localhost/);
  });
});
