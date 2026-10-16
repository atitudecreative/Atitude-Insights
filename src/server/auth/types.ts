export type GlobalRole = "superadmin" | "agency" | "ministry";
export type AgencyGlobalAccess = "none" | "read" | "manage";
export type MinistryRole = "agency_manager" | "agency_viewer" | "leader" | "operational";

/** Usuário autenticado. Contém apenas dados não sensíveis. */
export interface Actor {
  userId: string;
  sessionId: string;
  email: string;
  name: string;
  globalRole: GlobalRole;
  agencyGlobalAccess: AgencyGlobalAccess;
}

export const GLOBAL_ROLE_LABEL: Record<GlobalRole, string> = {
  superadmin: "Superadministrador",
  agency: "Equipe da agência",
  ministry: "Ministério",
};

export const MINISTRY_ROLE_LABEL: Record<MinistryRole, string> = {
  agency_manager: "Agência — gestão",
  agency_viewer: "Agência — consulta",
  leader: "Liderança do ministério",
  operational: "Responsável operacional",
};

export const AGENCY_ACCESS_LABEL: Record<AgencyGlobalAccess, string> = {
  none: "Somente ministérios atribuídos",
  read: "Visão global (consulta)",
  manage: "Visão global (gestão)",
};

export function hasGlobalRead(actor: Pick<Actor, "globalRole" | "agencyGlobalAccess">): boolean {
  return actor.globalRole === "superadmin" || (actor.globalRole === "agency" && actor.agencyGlobalAccess !== "none");
}

export function hasGlobalManage(actor: Pick<Actor, "globalRole" | "agencyGlobalAccess">): boolean {
  return actor.globalRole === "superadmin" || (actor.globalRole === "agency" && actor.agencyGlobalAccess === "manage");
}

export function isAgencyStaff(actor: Pick<Actor, "globalRole">): boolean {
  return actor.globalRole === "superadmin" || actor.globalRole === "agency";
}
