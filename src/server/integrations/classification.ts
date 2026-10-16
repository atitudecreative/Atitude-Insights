/**
 * Motor de classificação de itens externos (tarefas do Asana, campanhas e
 * publicações da Meta) em ministérios. Regras explícitas têm precedência;
 * o vínculo ativo ⇄ ministério só é usado quando aponta para UM ministério.
 * Na dúvida, o item vai para a fila de revisão manual — nunca por nome.
 */

export interface MappingRule {
  id: string;
  rule_type: "asana_project" | "asana_section" | "asana_tag" | "asana_custom_field" | "meta_campaign_name_prefix";
  external_asset_id: string | null;
  match_field: string | null;
  match_value: string | null;
  ministry_id: string;
  campaign_id: string | null;
  event_id: string | null;
  priority: number;
  active: boolean;
}

export interface Classification {
  ministryId: string | null;
  campaignId: string | null;
  eventId: string | null;
  classification: "auto" | "unclassified";
  reason: string;
}

interface Match {
  rule: MappingRule;
  label: string;
}

function decide(matches: Match[], fallbackMinistries: string[], fallbackLabel: string): Classification {
  if (matches.length > 0) {
    const best = Math.min(...matches.map((m) => m.rule.priority));
    const top = matches.filter((m) => m.rule.priority === best);
    const ministries = new Set(top.map((m) => m.rule.ministry_id));
    if (ministries.size > 1) {
      return { ministryId: null, campaignId: null, eventId: null, classification: "unclassified",
        reason: `Regras conflitantes com a mesma prioridade (${top.map((m) => m.label).join(", ")})` };
    }
    const campaigns = new Set(top.map((m) => m.rule.campaign_id).filter(Boolean));
    const events = new Set(top.map((m) => m.rule.event_id).filter(Boolean));
    return {
      ministryId: top[0]!.rule.ministry_id,
      campaignId: campaigns.size === 1 ? [...campaigns][0]! : null,
      eventId: events.size === 1 ? [...events][0]! : null,
      classification: "auto",
      reason: `Regra: ${top.map((m) => m.label).join(", ")}`,
    };
  }
  const unique = [...new Set(fallbackMinistries)];
  if (unique.length === 1) {
    return { ministryId: unique[0]!, campaignId: null, eventId: null, classification: "auto", reason: fallbackLabel };
  }
  if (unique.length > 1) {
    return { ministryId: null, campaignId: null, eventId: null, classification: "unclassified",
      reason: "O ativo de origem está associado a vários ministérios — revisão necessária" };
  }
  return { ministryId: null, campaignId: null, eventId: null, classification: "unclassified",
    reason: "Nenhuma regra ou associação de ativo aplicável" };
}

export interface AsanaTaskFacts {
  /** IDs locais (external_assets.id) dos projetos do Asana em que a tarefa está. */
  projectAssetIds: string[];
  sectionGids: string[];
  tagGids: string[];
  customFields: Array<{ gid: string; enumOptionGids: string[]; displayValue: string | null }>;
}

export function classifyAsanaTask(
  facts: AsanaTaskFacts,
  rules: MappingRule[],
  assetMinistries: Map<string, string[]>,
): Classification {
  const matches: Match[] = [];
  for (const rule of rules) {
    if (!rule.active) continue;
    // Regras vinculadas a um projeto só valem para tarefas daquele projeto.
    if (rule.external_asset_id && !facts.projectAssetIds.includes(rule.external_asset_id)) continue;
    switch (rule.rule_type) {
      case "asana_project":
        if (rule.external_asset_id) matches.push({ rule, label: "projeto" });
        break;
      case "asana_section":
        if (rule.match_value && facts.sectionGids.includes(rule.match_value)) matches.push({ rule, label: "seção" });
        break;
      case "asana_tag":
        if (rule.match_value && facts.tagGids.includes(rule.match_value)) matches.push({ rule, label: "tag" });
        break;
      case "asana_custom_field": {
        const field = facts.customFields.find((f) => f.gid === rule.match_field);
        if (!field || !rule.match_value) break;
        const value = rule.match_value.trim().toLowerCase();
        if (field.enumOptionGids.includes(rule.match_value) || field.displayValue?.trim().toLowerCase() === value) {
          matches.push({ rule, label: "campo personalizado" });
        }
        break;
      }
      default:
        break;
    }
  }
  const fallback = facts.projectAssetIds.flatMap((id) => assetMinistries.get(id) ?? []);
  return decide(matches, fallback, "Projeto do Asana associado a um único ministério");
}

export function classifyMetaCampaign(
  facts: { adAccountAssetId: string; name: string },
  rules: MappingRule[],
  assetMinistries: Map<string, string[]>,
): Classification {
  const matches: Match[] = [];
  const name = facts.name.trim().toLowerCase();
  for (const rule of rules) {
    if (!rule.active || rule.rule_type !== "meta_campaign_name_prefix" || !rule.match_value) continue;
    if (rule.external_asset_id && rule.external_asset_id !== facts.adAccountAssetId) continue;
    if (name.startsWith(rule.match_value.trim().toLowerCase())) matches.push({ rule, label: `prefixo "${rule.match_value}"` });
  }
  return decide(matches, assetMinistries.get(facts.adAccountAssetId) ?? [], "Conta de anúncios associada a um único ministério");
}

export function classifyByAsset(assetId: string, assetMinistries: Map<string, string[]>): Classification {
  return decide([], assetMinistries.get(assetId) ?? [], "Conta associada a um único ministério");
}
