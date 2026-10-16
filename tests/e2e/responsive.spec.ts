import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { ids, login } from "./helpers";
import { E2E } from "./seed";

const PAGES = ["/painel", "/ministerios", "/ministerios/atitude-kids", "/campanhas", "/eventos", "/demandas", "/entregaveis", "/resultados", "/relatorios"];

test("login acessível e sem rolagem horizontal", async ({ page }) => {
  await page.goto("/login");
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(results.violations.filter((v) => v.impact === "critical" || v.impact === "serious").map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
});

test("páginas principais sem rolagem horizontal e sem violações graves", async ({ page }) => {
  await login(page, E2E.admin);
  for (const url of [...PAGES, `/campanhas/${ids().campA}`, "/admin", "/admin/usuarios", "/admin/integracoes"]) {
    const res = await page.goto(url);
    expect(res?.status(), url).toBe(200);
    await page.waitForLoadState("networkidle");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, `rolagem horizontal em ${url}`).toBeLessThanOrEqual(1);
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
    const serious = results.violations.filter((v) => v.impact === "critical" || v.impact === "serious");
    expect(serious.map((v) => `${v.id}: ${v.nodes[0]?.target}`), url).toEqual([]);
  }
});

test("navegação mobile abre o menu", async ({ page, viewport }) => {
  test.skip((viewport?.width ?? 1440) > 1000, "somente mobile");
  await login(page, E2E.leaderA);
  await page.getByRole("button", { name: "Abrir menu" }).click();
  await expect(page.getByRole("link", { name: "Campanhas" })).toBeVisible();
});
