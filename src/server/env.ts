import "server-only";
import { z } from "zod";

/**
 * Variáveis de ambiente validadas. Nunca importe este módulo em componentes
 * de cliente: ele contém segredos (o pacote `server-only` impede isso no build).
 */
const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL é obrigatória"),
  APP_URL: z.string().url().default("http://localhost:3000"),
  // 32 bytes em base64. Gere com: openssl rand -base64 32
  ENCRYPTION_KEY: z.string().min(40, "ENCRYPTION_KEY deve ter 32 bytes em base64"),
  ENCRYPTION_KEY_PREVIOUS: z.string().optional(),
  CRON_SECRET: z.string().min(24).optional(),
  SESSION_IDLE_HOURS: z.coerce.number().int().positive().default(72),
  SESSION_ABSOLUTE_DAYS: z.coerce.number().int().positive().default(14),
  ASANA_CLIENT_ID: z.string().optional(),
  ASANA_CLIENT_SECRET: z.string().optional(),
  META_APP_ID: z.string().optional(),
  META_APP_SECRET: z.string().optional(),
  META_GRAPH_VERSION: z.string().regex(/^v\d+\.\d+$/).default("v23.0"),
  BRAND_NAME: z.string().default("Atitude Insights"),
  BRAND_ORGANIZATION: z.string().default("Agência de Comunicação"),
  BRAND_PRIMARY_COLOR: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#4f46e5"),
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

export function env(): Env {
  if (!cached) {
    const parsed = schema.safeParse(process.env);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      throw new Error(`Configuração inválida: ${issues}`);
    }
    cached = parsed.data;
  }
  return cached;
}

export const isProduction = () => env().NODE_ENV === "production";
