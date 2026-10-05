/**
 * Ambient module declarations for assets imported as text by the bundler.
 * esbuild's `.css → text` loader turns the stylesheets into strings, so the
 * in-page overlay can inject them into its shadow root.
 */

declare module '*.css' {
  const content: string;
  export default content;
}