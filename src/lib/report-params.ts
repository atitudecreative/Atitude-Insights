import { addDays, todayIso } from "./period";

/** Converte parâmetros da URL em parâmetros de relatório (validados no serviço). */
export function reportParamsFromSearch(get: (k: string) => string | undefined) {
  const escopo = get("escopo");
  const campaignId = get("campanha") ?? "";
  const eventId = get("evento") ?? "";
  const scopeType = escopo === "campaign" || escopo === "event" || escopo === "agency" || escopo === "ministry"
    ? escopo : campaignId ? "campaign" : eventId ? "event" : get("ministerio") ? "ministry" : "agency";
  const end = get("fim") ?? todayIso();
  return {
    scopeType, ministryId: get("ministerio") ?? "", campaignId, eventId, channel: get("canal") ?? "",
    start: get("inicio") ?? addDays(end, -29), end,
  };
}
