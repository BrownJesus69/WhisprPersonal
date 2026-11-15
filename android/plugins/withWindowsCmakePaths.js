const { withAppBuildGradle } = require('@expo/config-plugins');

const MARKER = '// whispr: windows cmake object paths';

/**
 * Local Windows builds only: the SDK's ninja 1.10 cannot stat paths over 260 characters, and
 * codegen objects (e.g. react-native-gesture-handler shadow nodes) exceed that. CMake hashes
 * object paths longer than CMAKE_OBJECT_PATH_MAX, keeping them short. The limit must leave room
 * for the object directory (~155 chars) plus md5/filename, or CMake silently skips shortening.
 * No effect on EAS/Linux.
 */
module.exports = function withWindowsCmakePaths(config) {
  if (process.platform !== 'win32') return config;
  return withAppBuildGradle(config, result => {
    if (!result.modResults.contents.includes(MARKER)) {
      result.modResults.contents += `
${MARKER}
android { defaultConfig { externalNativeBuild { cmake { arguments "-DCMAKE_OBJECT_PATH_MAX=250" } } } }
`;
    }
    return result;
  });
};
