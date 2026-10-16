import { describe, expect, it } from "vitest";
import { compare, costPerResult, cpc, cpm, ctr, engagement, goalProgress, isStale, safeDivide, sumNullable, toMetric } from "@/lib/metrics";

describe("indicadores calculados", () => {
  it("CTR = cliques / impressões × 100", () => {
    expect(ctr(50, 2000)).toBeCloseTo(2.5);
    expect(ctr(0, 2000)).toBe(0);
  });
  it("CPC = investimento / cliques", () => expect(cpc(100, 40)).toBeCloseTo(2.5));
  it("CPM = investimento / impressões × 1000", () => expect(cpm(30, 12000)).toBeCloseTo(2.5));
  it("custo por resultado = investimento / resultados", () => expect(costPerResult(90, 30)).toBe(3));

  it("denominador zero ou ausente não gera número", () => {
    expect(ctr(10, 0)).toBeNull();
    expect(cpc(100, 0)).toBeNull();
    expect(cpm(100, null)).toBeNull();
    expect(costPerResult(null, 10)).toBeNull();
    expect(safeDivide(Number.NaN, 1)).toBeNull();
  });

  it("somas ignoram ausentes, mas não transformam ausência em zero", () => {
    expect(sumNullable([1, null, 2])).toBe(3);
    expect(sumNullable([null, undefined])).toBeNull();
    expect(sumNullable([0, null])).toBe(0);
  });

  it("engajamento soma apenas componentes disponíveis", () => {
    expect(engagement({ likes: 10, comments: 2 })).toBe(12);
    expect(engagement({})).toBeNull();
  });

  it("progresso de meta", () => {
    expect(goalProgress(50, 200)).toBe(25);
    expect(goalProgress(10, 0)).toBeNull();
  });
});

describe("comparação de períodos", () => {
  it("calcula variação percentual", () => {
    const c = compare(150, 100);
    expect(c.percent).toBeCloseTo(50);
    expect(c.direction).toBe("up");
  });
  it("queda", () => expect(compare(50, 100).direction).toBe("down"));
  it("sem período anterior não inventa variação", () => {
    expect(compare(100, null)).toMatchObject({ percent: null, direction: "none", reason: "no_previous" });
  });
  it("base zero: variação absoluta sem percentual", () => {
    expect(compare(10, 0)).toMatchObject({ percent: null, absolute: 10, reason: "previous_zero" });
  });
  it("sem dado atual", () => expect(compare(null, 10).reason).toBe("no_current"));
});

describe("estados de métrica", () => {
  it("zero real é valor, ausência é indisponível", () => {
    expect(toMetric(0, { hasSource: true })).toMatchObject({ state: "value", value: 0 });
    expect(toMetric(null, { hasSource: true })).toMatchObject({ state: "unavailable", value: null });
  });
  it("sem integração = desconectada; sincronizando = processamento", () => {
    expect(toMetric(null, { hasSource: false }).state).toBe("disconnected");
    expect(toMetric(null, { hasSource: true, syncing: true }).state).toBe("processing");
  });
  it("restrito tem precedência", () => expect(toMetric(10, { hasSource: true, restricted: true }).state).toBe("restricted"));
  it("dados antigos são marcados como desatualizados", () => {
    const now = new Date("2026-05-10T00:00:00Z");
    expect(toMetric(5, { hasSource: true, updatedAt: "2026-05-01T00:00:00Z", now }).stale).toBe(true);
    expect(isStale("2026-05-09T12:00:00Z", 48, now)).toBe(false);
  });
});
