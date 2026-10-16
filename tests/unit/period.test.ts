import { describe, expect, it } from "vitest";
import { bucketFor, bucketKey, enumerateBuckets, isIsoDate, parsePeriod, previousPeriod, todayIso } from "@/lib/period";

describe("períodos", () => {
  const today = "2026-05-15";
  it("padrão: últimos 30 dias", () => {
    expect(parsePeriod({}, today)).toMatchObject({ start: "2026-04-16", end: "2026-05-15", preset: "30d" });
  });
  it("mês anterior", () => expect(parsePeriod({ periodo: "last_month" }, today)).toMatchObject({ start: "2026-04-01", end: "2026-04-30" }));
  it("trimestre e ano", () => {
    expect(parsePeriod({ periodo: "quarter" }, today).start).toBe("2026-04-01");
    expect(parsePeriod({ periodo: "year" }, today).start).toBe("2026-01-01");
  });
  it("personalizado válido e inválido", () => {
    expect(parsePeriod({ periodo: "custom", inicio: "2026-01-10", fim: "2026-02-10" }, today)).toMatchObject({ start: "2026-01-10", end: "2026-02-10" });
    expect(parsePeriod({ periodo: "custom", inicio: "2026-02-31", fim: "2026-01-01" }, today).start).toBe("2026-04-16");
    expect(parsePeriod({ periodo: "custom", inicio: "'; drop table", fim: "x" }, today).end).toBe(today);
  });
  it("período anterior de mesma duração", () => {
    expect(previousPeriod({ start: "2026-04-01", end: "2026-04-30" })).toEqual({ start: "2026-03-02", end: "2026-03-31" });
    expect(previousPeriod({ start: "2026-05-15", end: "2026-05-15" })).toEqual({ start: "2026-05-14", end: "2026-05-14" });
  });
  it("valida datas ISO", () => {
    expect(isIsoDate("2026-02-29")).toBe(false);
    expect(isIsoDate("2028-02-29")).toBe(true);
  });
  it("baldes de agregação", () => {
    expect(bucketFor({ start: "2026-01-01", end: "2026-01-30" })).toBe("day");
    expect(bucketFor({ start: "2026-01-01", end: "2026-04-30" })).toBe("week");
    expect(bucketFor({ start: "2025-01-01", end: "2026-01-01" })).toBe("month");
    expect(bucketKey("2026-05-14", "week")).toBe("2026-05-11");
    expect(enumerateBuckets({ start: "2026-01-15", end: "2026-03-02" }, "month")).toEqual(["2026-01-01", "2026-02-01", "2026-03-01"]);
  });
  it("hoje em São Paulo", () => {
    expect(todayIso("America/Sao_Paulo", new Date("2026-05-15T02:00:00Z"))).toBe("2026-05-14");
  });
});
