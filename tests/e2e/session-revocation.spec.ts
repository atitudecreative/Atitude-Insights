import { expect, test } from "@playwright/test";
import { ids, login, sql } from "./helpers";
import { E2E } from "./seed";

test("usuário removido perde o acesso imediatamente", async ({ page }) => {
  await login(page, E2E.removed);
  await page.goto("/campanhas");
  await expect(page.getByText("Conferência Kids 2026").first()).toBeVisible();

  // Remoção do vínculo: próxima requisição já não enxerga o ministério.
  await sql("delete from app.ministry_memberships where user_id = $1", [ids().removedUser]);
  await page.goto("/campanhas");
  await expect(page.getByText("Conferência Kids 2026")).toHaveCount(0);
  const res = await page.goto(`/campanhas/${ids().campA}`);
  expect(res?.status()).toBe(404);

  // Desativação do usuário: a sessão deixa de ser aceita.
  await sql("update app.users set status = 'disabled' where id = $1", [ids().removedUser]);
  await page.goto("/painel");
  await expect(page).toHaveURL(/\/login/);
});
