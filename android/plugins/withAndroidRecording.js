const { withAndroidManifest } = require('@expo/config-plugins');

/** Keep Android-only introspection independent of Firebase's iOS credential requirement. */
module.exports = function withAndroidRecording(config) {
  if (config.platforms?.length === 1 && config.platforms[0] === 'android' && config.mods) {
    delete config.mods.ios;
  }
  return withAndroidManifest(config, result => {
    // Prebuild can reuse Phase 4's manifest, which blocked the mic with tools:node=remove.
    // Removing it from blockedPermissions alone does not remove that existing XML marker.
    const manifest = result.modResults.manifest;
    manifest['uses-permission'] = (manifest['uses-permission'] ?? []).filter(p =>
      !(p.$['android:name'] === 'android.permission.RECORD_AUDIO' && p.$['tools:node'] === 'remove'));
    return result;
  });
};
