// The app isn't signed with an Apple developer certificate, so it's signed "ad hoc" here:
// Apple silicon Macs refuse to start an app with no signature at all. macOS still asks the
// person to allow it once (System Settings, Privacy & Security, Open Anyway).
const { execFileSync } = require("node:child_process");
const path = require("node:path");

exports.default = async function afterPack(ctx) {
  if (ctx.electronPlatformName !== "darwin" || process.platform !== "darwin") return;
  const app = path.join(ctx.appOutDir, `${ctx.packager.appInfo.productFilename}.app`);
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", app], { stdio: "inherit" });
};
