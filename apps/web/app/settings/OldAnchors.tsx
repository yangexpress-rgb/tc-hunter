"use client";
import { useEffect } from "react";

/** Links saved before Settings was split (e.g. /settings#email) still land on the right page. */
const MOVED: Record<string, string> = {
  "#email": "/settings/email", "#job-sites": "/settings/job-sites", "#applying": "/settings/applying",
  "#browser": "/settings/applying#browser", "#data": "/settings/data", "#delete": "/settings/data#delete",
};

export function OldAnchors() {
  useEffect(() => {
    const to = MOVED[window.location.hash];
    if (to) window.location.replace(to);
  }, []);
  return null;
}
