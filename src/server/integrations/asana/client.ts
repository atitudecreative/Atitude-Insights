import { defaultHttpDeps, IntegrationError, parseRetryAfter, requestJson, type HttpDeps } from "../http";

/**
 * Cliente tipado e enxuto da API REST do Asana (v1.0). Todas as chamadas
 * passam por `requestJson`, que repete falhas temporárias (429/5xx/rede)
 * respeitando o Retry-After. O token nunca aparece em mensagens de erro.
 */
export const ASANA_API_BASE = "https://app.asana.com/api/1.0";
export const ASANA_PAGE_LIMIT = 100;

export interface AsanaWorkspace {
  gid: string;
  name: string;
}

export interface AsanaUser {
  gid: string;
  name: string;
  email?: string | null;
  workspaces: AsanaWorkspace[];
}

export interface AsanaProject {
  gid: string;
  name: string;
  archived?: boolean;
  color?: string | null;
  permalink_url?: string | null;
  team?: { gid?: string; name?: string | null } | null;
}

export interface AsanaSection {
  gid: string;
  name: string;
}

export interface AsanaEnumOption {
  gid: string;
  name: string;
  enabled?: boolean;
  color?: string | null;
}

export interface AsanaCustomFieldSetting {
  gid: string;
  custom_field: {
    gid: string;
    name: string;
    type?: string;
    resource_subtype?: string;
    enum_options?: AsanaEnumOption[] | null;
  };
}

export interface AsanaTaskCustomField {
  gid: string;
  name: string;
  type?: string | null;
  display_value?: string | null;
  enum_value?: { gid: string; name?: string | null } | null;
  multi_enum_values?: Array<{ gid: string; name?: string | null }> | null;
}

export interface AsanaTask {
  gid: string;
  name: string;
  notes?: string | null;
  completed?: boolean;
  completed_at?: string | null;
  due_on?: string | null;
  due_at?: string | null;
  start_on?: string | null;
  created_at?: string | null;
  modified_at?: string | null;
  permalink_url?: string | null;
  assignee?: { gid: string; name?: string | null } | null;
  tags?: Array<{ gid: string; name?: string | null }> | null;
  memberships?: Array<{
    project?: { gid: string; name?: string | null } | null;
    section?: { gid: string; name?: string | null } | null;
  }> | null;
  custom_fields?: AsanaTaskCustomField[] | null;
}

/** Uma página da paginação por offset do Asana. */
export interface AsanaPage<T> {
  data: T[];
  /** Offset da próxima página; null quando não há mais páginas. */
  nextOffset: string | null;
}

interface AsanaListResponse<T> {
  data: T[];
  next_page?: { offset?: string | null } | null;
}

export const ASANA_TASK_OPT_FIELDS = [
  "name", "notes", "completed", "completed_at", "due_on", "due_at", "start_on", "created_at", "modified_at",
  "permalink_url", "assignee.name", "assignee.gid", "tags.name", "tags.gid",
  "memberships.project.gid", "memberships.project.name", "memberships.section.gid", "memberships.section.name",
  "custom_fields.gid", "custom_fields.name", "custom_fields.type", "custom_fields.display_value",
  "custom_fields.enum_value.gid", "custom_fields.enum_value.name",
  "custom_fields.multi_enum_values.gid", "custom_fields.multi_enum_values.name",
].join(",");

const PROJECT_OPT_FIELDS = "name,archived,color,permalink_url,team.name";
const USER_OPT_FIELDS = "gid,name,email,workspaces.gid,workspaces.name";
const CUSTOM_FIELD_SETTING_OPT_FIELDS = [
  "custom_field.gid", "custom_field.name", "custom_field.type", "custom_field.resource_subtype",
  "custom_field.enum_options.gid", "custom_field.enum_options.name", "custom_field.enum_options.enabled",
  "custom_field.enum_options.color",
].join(",");

function extractAsanaMessage(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const errors = (body as { errors?: unknown }).errors;
  if (!Array.isArray(errors)) return undefined;
  const messages = errors
    .map((e) => (e && typeof e === "object" ? (e as { message?: unknown }).message : undefined))
    .filter((m): m is string => typeof m === "string" && m.length > 0);
  return messages.length > 0 ? messages.join("; ") : undefined;
}

function stripToken(message: string, token?: string): string {
  if (!token || token.length < 4) return message;
  return message.split(token).join("[REDACTED]");
}

/**
 * Converte respostas de erro do Asana em IntegrationError. `token` é usado
 * apenas para garantir que ele jamais apareça na mensagem.
 */
export function classifyAsanaError(status: number, body: unknown, headers: Headers, token?: string): IntegrationError {
  const detail = stripToken(extractAsanaMessage(body) ?? `HTTP ${status}`, token);
  const message = `Asana: ${detail}`;
  if (status === 401) return new IntegrationError(message, "auth", status);
  if (status === 402 || status === 403) return new IntegrationError(message, "permission", status);
  if (status === 404) return new IntegrationError(message, "not_found", status);
  if (status === 429) return new IntegrationError(message, "rate_limit", status, undefined, parseRetryAfter(headers) ?? 60_000);
  if (status >= 500) return new IntegrationError(message, "transient", status, undefined, parseRetryAfter(headers));
  if (status === 400) return new IntegrationError(message, "invalid_request", status);
  return new IntegrationError(message, "permanent", status);
}

type Params = Record<string, string | number | boolean | undefined | null>;

export class AsanaClient {
  constructor(
    private readonly token: string,
    private readonly http: HttpDeps = defaultHttpDeps,
    private readonly baseUrl: string = ASANA_API_BASE,
  ) {}

  private url(path: string, params: Params = {}): string {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null) continue;
      search.set(key, String(value));
    }
    const query = search.toString();
    return `${this.baseUrl}${path}${query ? `?${query}` : ""}`;
  }

  private request<T>(path: string, params: Params = {}): Promise<T> {
    return requestJson<T>(this.url(path, params), {
      headers: { Authorization: `Bearer ${this.token}` },
      classifyError: (status, body, headers) => classifyAsanaError(status, body, headers, this.token),
    }, this.http);
  }

  /** Busca UMA página de uma listagem (permite checkpoint entre páginas). */
  async getPage<T>(path: string, params: Params = {}, offset?: string | null): Promise<AsanaPage<T>> {
    const response = await this.request<AsanaListResponse<T>>(path, { ...params, limit: ASANA_PAGE_LIMIT, offset: offset ?? undefined });
    return { data: response?.data ?? [], nextOffset: response?.next_page?.offset ?? null };
  }

  /** Percorre todas as páginas, uma de cada vez, seguindo `next_page.offset`. */
  async *pages<T>(path: string, params: Params = {}, startOffset?: string | null): AsyncGenerator<AsanaPage<T>> {
    let offset: string | null | undefined = startOffset;
    do {
      const page: AsanaPage<T> = await this.getPage<T>(path, params, offset);
      yield page;
      offset = page.nextOffset;
    } while (offset);
  }

  async listAll<T>(path: string, params: Params = {}): Promise<T[]> {
    const out: T[] = [];
    for await (const page of this.pages<T>(path, params)) out.push(...page.data);
    return out;
  }

  async getMe(): Promise<AsanaUser> {
    const response = await this.request<{ data: AsanaUser }>("/users/me", { opt_fields: USER_OPT_FIELDS });
    const user = response.data;
    return { gid: user.gid, name: user.name, email: user.email ?? null, workspaces: user.workspaces ?? [] };
  }

  listProjects(workspaceGid: string): Promise<AsanaProject[]> {
    return this.listAll<AsanaProject>("/projects", { workspace: workspaceGid, archived: false, opt_fields: PROJECT_OPT_FIELDS });
  }

  /** Uma página de tarefas do projeto (GET /tasks?project=…). */
  listTasks(input: { projectGid: string; modifiedSince?: string | null; offset?: string | null }): Promise<AsanaPage<AsanaTask>> {
    return this.getPage<AsanaTask>("/tasks", {
      project: input.projectGid,
      modified_since: input.modifiedSince ?? undefined,
      opt_fields: ASANA_TASK_OPT_FIELDS,
    }, input.offset);
  }

  listSections(projectGid: string): Promise<AsanaSection[]> {
    return this.listAll<AsanaSection>(`/projects/${encodeURIComponent(projectGid)}/sections`, { opt_fields: "name" });
  }

  listCustomFieldSettings(projectGid: string): Promise<AsanaCustomFieldSetting[]> {
    return this.listAll<AsanaCustomFieldSetting>(`/projects/${encodeURIComponent(projectGid)}/custom_field_settings`, {
      opt_fields: CUSTOM_FIELD_SETTING_OPT_FIELDS,
    });
  }
}
