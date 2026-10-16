import "server-only";
import { cookies } from "next/headers";

export type DataMode = "production" | "demo";
export const MODE_COOKIE = "ai_mode";

/**
 * Modo de dados: produção (padrão) ou demonstração. Os dois NUNCA são
 * misturados — cada consulta filtra por ministries.is_demo conforme o modo.
 */
export async function getDataMode(): Promise<DataMode> {
  const store = await cookies();
  return store.get(MODE_COOKIE)?.value === "demo" ? "demo" : "production";
}
