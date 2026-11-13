import type { ReactNode } from "react";
import { t } from "@tc-hunter/domain/messages";

/** Layer 3 (brief 2.1): collapsed, labelled "Advanced". Technical detail lives only here. */
export function Advanced({ children }: { children: ReactNode }) {
  return (
    <details className="layer3">
      <summary>{t("layer.advanced")}</summary>
      <div className="layer-body mono">{children}</div>
    </details>
  );
}

export function AdvancedRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="adv-row">
      <span className="adv-label">{label}</span>
      <span>{value}</span>
    </div>
  );
}
