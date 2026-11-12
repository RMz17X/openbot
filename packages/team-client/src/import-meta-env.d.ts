/**
 * The build-time settings the direct host reads.
 *
 * The team client is built twice: once for the browser, where Vite replaces `import.meta.env`
 * with the settings of the build, and once for the Electron main process, where there is no
 * `import.meta.env` at all. The declaration below is the shape both builds agree on. It names
 * only the settings the client reads, so the package does not depend on Vite's own types.
 */

interface ImportMetaEnv {
  readonly VITE_OPENBOT_DIRECT_HOST_URL?: string;
  readonly VITE_OPENBOT_DIRECT_HOST_TOKEN?: string;
  readonly VITE_OPENBOT_DIRECT_HOST_USERNAME?: string;
  readonly VITE_OPENBOT_DIRECT_HOST_PASSWORD?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
