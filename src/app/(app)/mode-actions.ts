"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { requireActor } from "@/server/auth/current";
import { isAgencyStaff } from "@/server/auth/types";
import { MODE_COOKIE } from "@/server/services/mode";

export async function setModeAction(form: FormData): Promise<void> {
  const actor = await requireActor();
  if (!isAgencyStaff(actor)) return;
  const store = await cookies();
  if (form.get("mode") === "demo") store.set(MODE_COOKIE, "demo", { httpOnly: true, sameSite: "lax", path: "/" });
  else store.delete(MODE_COOKIE);
  revalidatePath("/", "layout");
}
