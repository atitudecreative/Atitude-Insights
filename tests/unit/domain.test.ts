import { describe, expect, it } from "vitest";
import { taskStatus } from "@/lib/labels";
import { reportParamsFromSearch } from "@/lib/report-params";
import { eventStages } from "@/server/services/events";
import { contrastText } from "@/server/services/settings";

describe("status de demanda (sem inventar conclusão)", () => {
  const today = "2026-05-10";
  it("concluída somente com evidência", () => {
    expect(taskStatus({ completed: true, due_on: "2026-01-01" }, today)).toBe("completed");
    expect(taskStatus({ completed: false, due_on: "2026-05-09" }, today)).toBe("overdue");
    expect(taskStatus({ completed: false, due_on: null }, today)).toBe("open");
    expect(taskStatus({ completed: false, due_on: "2026-05-10" }, today)).toBe("open");
    expect(taskStatus({ completed: true, due_on: null, removed_in_source_at: new Date() }, today)).toBe("removed");
  });
});

describe("etapas de comunicação do evento", () => {
  const base = { created_at: new Date("2026-01-01"), promotion_start: "2026-05-01", promotion_end: "2026-05-30", starts_at: new Date("2026-06-01T22:00:00Z"), ends_at: new Date("2026-06-02T02:00:00Z"), results_consolidated_at: null, status: "confirmed" };
  const current = (now: string, extra = {}) => eventStages({ ...base, ...extra }, new Date(now)).find((s) => s.state === "current")?.key;
  it("deriva a etapa atual das datas", () => {
    expect(current("2026-04-01T12:00:00Z")).toBe("production");
    expect(current("2026-04-01T12:00:00Z", { status: "planned" })).toBe("planning");
    expect(current("2026-05-10T12:00:00Z")).toBe("promotion");
    expect(current("2026-06-01T23:00:00Z")).toBe("event");
    expect(current("2026-06-05T12:00:00Z")).toBe("post_event");
    expect(current("2026-06-05T12:00:00Z", { results_consolidated_at: new Date() })).toBe("consolidation");
  });
  it("etapas anteriores ficam concluídas", () => {
    const steps = eventStages(base, new Date("2026-06-05T12:00:00Z"));
    expect(steps.filter((s) => s.state === "done").map((s) => s.key)).toEqual(["planning", "production", "promotion", "event"]);
  });
});

describe("parâmetros de relatório pela URL", () => {
  it("infere o escopo", () => {
    const get = (m: Record<string, string>) => (k: string) => m[k];
    expect(reportParamsFromSearch(get({ campanha: "x" })).scopeType).toBe("campaign");
    expect(reportParamsFromSearch(get({ ministerio: "m" })).scopeType).toBe("ministry");
    expect(reportParamsFromSearch(get({})).scopeType).toBe("agency");
    expect(reportParamsFromSearch(get({ escopo: "event", evento: "e", inicio: "2026-01-01", fim: "2026-01-31" }))).toMatchObject({ scopeType: "event", start: "2026-01-01", end: "2026-01-31" });
  });
});

describe("identidade visual", () => {
  it("texto sobre a cor da marca mantém contraste", () => {
    expect(contrastText("#4f46e5")).toBe("#ffffff");
    expect(contrastText("#fde047")).toBe("#0f172a");
  });
});
