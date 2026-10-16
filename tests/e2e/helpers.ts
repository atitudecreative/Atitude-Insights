import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, type Page } from "@playwright/test";
import pg from "pg";
import { E2E_PASSWORD } from "./seed";

export function ids(): Record<string, string> {
  return JSON.parse(readFileSync(path.join(__dirname, ".e2e-ids.json"), "utf8")) as Record<string, string>;
}

export async function login(page: Page, email: string, password = E2E_PASSWORD) {
  await page.goto("/login");
  await page.getByLabel("E-mail").fill(email);
  await page.getByLabel("Senha").fill(password);
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

export async function sql(query: string, params: unknown[] = []) {
  const client = new pg.Client({ connectionString: `postgresql://atitude:atitude@localhost:5432/${process.env.E2E_DATABASE_NAME ?? "atitude_e2e"}` });
  await client.connect();
  try {
    return (await client.query(query, params)).rows;
  } finally {
    await client.end();
  }
}
