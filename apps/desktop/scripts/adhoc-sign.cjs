/**
 * electron-builder `afterPack` hook — ad-hoc code signing for macOS.
 *
 * WHY THIS EXISTS. The mac config sets `identity: null`, which makes
 * electron-builder log "skipped macOS code signing" and sign nothing at all.
 * On Intel that is merely untidy. On Apple Silicon it is fatal: macOS refuses
 * to launch an arm64 binary that carries no signature whatsoever, and
 * repackaging the app invalidates the signature Electron's own binaries ship
 * with. A universal .dmg contains an arm64 slice, so without this the app is
 * dead on every M-series Mac — it gets killed on launch, usually surfacing as
 * "the application is damaged and can't be opened".
 *
 * An ad-hoc signature (`codesign --sign -`) satisfies that requirement. It is
 * NOT a Developer ID signature: the download still carries a quarantine flag,
 * so first launch still needs right-click → Open, or
 *   xattr -dr com.apple.quarantine "/Applications/IBKR Chart.app"
 * See the macOS section of the README.
 *
 * No-ops on every platform except darwin, so Windows builds are untouched —
 * `codesign` does not exist there.
 */

const { execFileSync } = require('node:child_process');
const path = require('node:path');

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = path.join(context.appOutDir, appName);

  // --deep is deprecated by Apple for real distribution signing, but it is the
  // documented way to ad-hoc sign a bundle's nested frameworks and helpers in
  // one pass, which is exactly what we need here.
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], {
    stdio: 'inherit',
  });

  // Fail the build loudly rather than shipping a .dmg that cannot launch.
  execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], {
    stdio: 'inherit',
  });

  console.log(`[adhoc-sign] ad-hoc signed and verified ${appName}`);
};
