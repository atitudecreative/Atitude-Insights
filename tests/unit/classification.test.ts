import { describe, expect, it } from "vitest";
import { classifyAsanaTask, classifyByAsset, classifyMetaCampaign, type MappingRule } from "@/server/integrations/classification";

const rule = (r: Partial<MappingRule>): MappingRule => ({
  id: Math.random().toString(36), rule_type: "asana_project", external_asset_id: null, match_field: null, match_value: null,
  ministry_id: "kids", campaign_id: null, event_id: null, priority: 100, active: true, ...r,
});
const facts = { projectAssetIds: ["p1"], sectionGids: ["s1"], tagGids: ["t1"], customFields: [{ gid: "cf1", enumOptionGids: ["opt-kids"], displayValue: "Kids" }] };

describe("classificação de tarefas do Asana", () => {
  it("usa o vínculo do projeto quando aponta para um único ministério", () => {
    expect(classifyAsanaTask(facts, [], new Map([["p1", ["kids"]]]))).toMatchObject({ ministryId: "kids", classification: "auto" });
  });
  it("projeto compartilhado entre ministérios vai para revisão", () => {
    expect(classifyAsanaTask(facts, [], new Map([["p1", ["kids", "mulheres"]]]))).toMatchObject({ ministryId: null, classification: "unclassified" });
  });
  it("regras explícitas têm precedência sobre o vínculo do projeto", () => {
    const r = classifyAsanaTask(facts, [rule({ rule_type: "asana_section", match_value: "s1", ministry_id: "global", campaign_id: "c1" })], new Map([["p1", ["kids"]]]));
    expect(r).toMatchObject({ ministryId: "global", campaignId: "c1", classification: "auto" });
  });
  it("campo personalizado por opção ou valor exibido", () => {
    expect(classifyAsanaTask(facts, [rule({ rule_type: "asana_custom_field", match_field: "cf1", match_value: "opt-kids" })], new Map()).ministryId).toBe("kids");
    expect(classifyAsanaTask(facts, [rule({ rule_type: "asana_custom_field", match_field: "cf1", match_value: "kids" })], new Map()).ministryId).toBe("kids");
  });
  it("regras conflitantes de mesma prioridade não decidem sozinhas", () => {
    const r = classifyAsanaTask(facts, [
      rule({ rule_type: "asana_tag", match_value: "t1", ministry_id: "kids" }),
      rule({ rule_type: "asana_section", match_value: "s1", ministry_id: "mulheres" }),
    ], new Map());
    expect(r.classification).toBe("unclassified");
  });
  it("prioridade menor vence", () => {
    const r = classifyAsanaTask(facts, [
      rule({ rule_type: "asana_tag", match_value: "t1", ministry_id: "kids", priority: 10 }),
      rule({ rule_type: "asana_section", match_value: "s1", ministry_id: "mulheres", priority: 50 }),
    ], new Map());
    expect(r.ministryId).toBe("kids");
  });
  it("regras de outro projeto são ignoradas e regras inativas também", () => {
    expect(classifyAsanaTask(facts, [rule({ rule_type: "asana_section", match_value: "s1", external_asset_id: "p2" })], new Map()).classification).toBe("unclassified");
    expect(classifyAsanaTask(facts, [rule({ rule_type: "asana_section", match_value: "s1", active: false })], new Map()).classification).toBe("unclassified");
  });
  it("sem regra nem vínculo: não classificada (nunca por nome)", () => {
    expect(classifyAsanaTask({ ...facts, projectAssetIds: [] }, [], new Map())).toMatchObject({ classification: "unclassified", ministryId: null });
  });
});

describe("classificação Meta", () => {
  it("prefixo de nome explícito configurado pelo administrador", () => {
    const rules = [rule({ rule_type: "meta_campaign_name_prefix", match_value: "[KIDS]", ministry_id: "kids" })];
    expect(classifyMetaCampaign({ adAccountAssetId: "a1", name: "[kids] Conferência" }, rules, new Map([["a1", ["x", "y"]]])).ministryId).toBe("kids");
    expect(classifyMetaCampaign({ adAccountAssetId: "a1", name: "Conferência" }, rules, new Map([["a1", ["x", "y"]]])).classification).toBe("unclassified");
  });
  it("conta de anúncios de um único ministério", () => {
    expect(classifyMetaCampaign({ adAccountAssetId: "a1", name: "Qualquer" }, [], new Map([["a1", ["kids"]]])).ministryId).toBe("kids");
    expect(classifyByAsset("ig1", new Map([["ig1", ["kids"]]])).ministryId).toBe("kids");
    expect(classifyByAsset("ig1", new Map()).classification).toBe("unclassified");
  });
});
