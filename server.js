// Root server entrypoint bridge. File-spec installs resolve subpath entries
// unreliably (silently skipped on some hosts), so keep a root entry that
// re-exports the built bundle.
export { default } from "./dist/server.js";
