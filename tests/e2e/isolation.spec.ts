import { expect, test } from "@playwright/test";
import { ids, login } from "./helpers";
import { E2E } from "./seed";

test.describe("Isolamento entre ministérios (navegador e API)", () => {
  test.beforeEach(async ({ page }) => login(page, E2E.leaderA));

  test("listas mostram apenas o ministério autorizado", async ({ page }) => {
    await page.goto("/campanhas");
    await expect(page.getByText("Conferência Kids 2026").first()).toBeVisible();
    await expect(page.getByText("Encontro Secreto de Mulheres")).toHaveCount(0);
    await page.goto("/ministerios");
    await expect(page.getByText("Mulheres", { exact: true })).toHaveCount(0);
  });

  test("alterar o ID na URL não dá acesso a outro ministério", async ({ page }) => {
    const i = ids();
    for (const url of [`/campanhas/${i.campB}`, `/campanhas/${i.campB}/editar`, `/eventos/${i.evB}`, `/entregaveis/${i.delB}`, `/relatorios/${i.reportB}`, "/ministerios/mulheres"]) {
      const res = await page.goto(url);
      expect(res?.status(), url).toBe(404);
      await expect(page.getByText(/Encontro Secreto|Retiro Mulheres|Peça confidencial/)).toHaveCount(0);
    }
  });

  test("filtros manipulados não agregam dados de outro ministério", async ({ page }) => {
    const i = ids();
    await page.goto(`/painel?ministerio=${i.B}&campanha=${i.campB}`);
    await expect(page.getByText(/Encontro Secreto|Vídeo secreto/)).toHaveCount(0);
    await page.goto(`/demandas?ministerio=${i.B}`);
    await expect(page.getByText("Vídeo secreto Mulheres")).toHaveCount(0);
  });

  test("chamadas diretas à API e downloads respeitam as permissões", async ({ page }) => {
    const i = ids();
    const r1 = await page.request.get(`/api/relatorios/${i.reportB}/pdf`);
    expect(r1.status()).toBe(404);
    const r2 = await page.request.get(`/api/relatorios/pdf?escopo=ministry&ministerio=${i.B}`);
    expect(r2.status()).toBe(404);
    const r3 = await page.request.get(`/api/relatorios/pdf?escopo=campaign&campanha=${i.campB}`);
    expect(r3.status()).toBe(404);
    const r4 = await page.request.get(`/api/relatorios/pdf?escopo=agency`);
    expect(r4.status()).toBe(404);
    const own = await page.request.get(`/api/relatorios/pdf?escopo=ministry&ministerio=${i.A}`);
    expect(own.status()).toBe(200);
    expect(own.headers()["content-type"]).toContain("application/pdf");
  });

  test("exportações CSV não incluem dados não autorizados", async ({ page }) => {
    const i = ids();
    const res = await page.request.get(`/api/exportar/demandas?ministerio=${i.B}`);
    expect(res.status()).toBe(200);
    const body = await res.text();
    expect(body).not.toContain("Vídeo secreto");
    const all = await page.request.get(`/api/exportar/demandas`);
    const text = await all.text();
    expect(text).toContain("Arte do convite Kids");
    expect(text).not.toContain("Vídeo secreto");
    const metrics = await page.request.get(`/api/exportar/metricas`);
    expect(metrics.status()).toBe(200);
  });

  test("configurações globais retornam 404 para quem não é administrador", async ({ page }) => {
    for (const url of ["/admin", "/admin/usuarios", "/admin/integracoes", "/admin/configuracoes", "/admin/auditoria", "/classificacao"]) {
      const res = await page.goto(url);
      expect(res?.status(), url).toBe(404);
    }
  });
});

test("equipe da agência sem visão global também não acessa administração", async ({ page }) => {
  await login(page, E2E.agency);
  for (const url of ["/admin", "/admin/usuarios", "/admin/integracoes"]) {
    const res = await page.goto(url);
    expect(res?.status(), url).toBe(404);
  }
  const res = await page.goto(`/campanhas/${ids().campB}`);
  expect(res?.status()).toBe(404);
});
