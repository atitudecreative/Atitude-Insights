import { describe, expect, it } from "vitest";
import { buildCsv, csvCell } from "@/server/services/export";

describe("csvCell — proteção contra injeção de fórmulas", () => {
  it.each(["=SUM(A1:A9)", "+5551999", "-2+3", "@cmd", "\tTAB", "\rCR"])("prefixa com apóstrofo: %j", (v) => {
    expect(csvCell(v).replace(/^"|"$/g, "").startsWith(`'${v[0]}`)).toBe(true);
  });

  it("neutraliza payload clássico de DDE e ainda aplica aspas", () => {
    expect(csvCell('=cmd|" /C calc"!A0')).toBe(`"'=cmd|"" /C calc""!A0"`);
  });

  it("mantém textos comuns intactos", () => {
    expect(csvCell("Arte do culto")).toBe("Arte do culto");
    expect(csvCell("a=b")).toBe("a=b");
  });

  it("aplica aspas em separador, aspas e quebras de linha", () => {
    expect(csvCell("Kids; Jovens")).toBe('"Kids; Jovens"');
    expect(csvCell('Diga "olá"')).toBe('"Diga ""olá"""');
    expect(csvCell("linha 1\nlinha 2")).toBe('"linha 1\nlinha 2"');
  });

  it("números (inclusive negativos) não recebem apóstrofo e usam vírgula decimal", () => {
    expect(csvCell(-12.5)).toBe("-12,5");
    expect(csvCell(1000)).toBe("1000");
    expect(csvCell(Number.NaN)).toBe("");
  });

  it("valores ausentes, booleanos e datas", () => {
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
    expect(csvCell(true)).toBe("sim");
    expect(csvCell(new Date("2026-03-01T15:00:00Z"))).toBe("2026-03-01 12:00:00");
  });
});

describe("buildCsv", () => {
  it("inclui BOM UTF-8, cabeçalho e CRLF", () => {
    const csv = buildCsv(["Nome", "Valor"], [["=1+1", 2], ["Ação", null]]);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv.slice(1)).toBe("Nome;Valor\r\n'=1+1;2\r\nAção;\r\n");
  });
});
