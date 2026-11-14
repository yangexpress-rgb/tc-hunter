import { redirect } from "next/navigation";
import type { PageProps } from "@/lib/profile";

/** Experience now lives as a section of the "About you" page. Old links land there. */
export default async function Page(props: PageProps) {
  const params = (await props.searchParams) ?? {};
  const qs = new URLSearchParams(Object.entries(params).flatMap(([k, v]) => (Array.isArray(v) ? v : v === undefined ? [] : [v]).map((x) => [k, String(x)] as [string, string]))).toString();
  redirect(`/profile${qs ? `?${qs}` : ""}#experience`);
}
