// esbuild bundles .html files as text (installer/build.mjs loader)
declare module '*.html' { const text: string; export default text; }
