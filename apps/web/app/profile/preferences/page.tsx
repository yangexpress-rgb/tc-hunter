import { redirect } from "next/navigation";

/** "What you want" is now Goals. Old links still land in the right place. */
export default function PreferencesPage() {
  redirect("/profile/goals");
}
