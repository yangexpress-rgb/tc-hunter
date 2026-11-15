import { redirect } from "next/navigation";

/** Adding a job by its link now lives on Matches (Yong, 2026-11-15); old links still land there. */
export default function PastePage() {
  redirect("/jobs#add-job");
}
